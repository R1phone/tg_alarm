export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};

const KEY_ALERT = "tg_alert_state";

const ENV = {
  MATTERMOST_WEBHOOK: "https://mm.mvpproject.io/hooks/1q715bsjzina5enz98x43bj7gc",
  BOT_TOKEN: "7564679631:AAFuJ4286u2r2EL-_0q7SgYmt_TdfdLoi2w",
  TEST_CHAT_ID: "855257187",
  MIN_CONSECUTIVE_FAILURES: 2,
  CHECK_HOST_MAX_NODES: 5,
  CHECK_HOST_FAIL_NODES: 2,
  MAX_RESPONSE_TIME_MS: 2000,
};

function short(s, n) { if (!s) return ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function stripTags(html) { 
  return (html || "").replace(/<script[\s\S]*?><\/script>/gi, "").replace(/<style[\s\S]*?><\/style>/gi, "").replace(/<\/?[^>]+(>|$)/g, ""); 
}

async function sendMattermost(webhook, text) {
  if (!webhook) return;
  const payload = { username: "tg-monitor", icon_url: "https://telegram.org/img/t_logo.png", text };
  try {
    await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    console.log("Mattermost notification sent successfully");
  } catch (e) {
    console.error("Failed to post to Mattermost:", e.message);
  }
}

async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.ok) {
      console.log("Telegram notification sent successfully");
    } else {
      console.warn(`Telegram sendMessage failed: status=${r.status}`);
    }
  } catch (e) {
    console.error(`Telegram sendMessage error: ${e.message}`);
  }
}

function testShouldAlert(signals) {
  const apiGetMeOk = !signals.find(s => s.source === "getMe" && s.problem);
  const multiFail = signals.find(s => s.source === "check-host" && s.problem);
  const webFails = signals.filter(s => s.source.includes("web.telegram.org") || s.source.includes("telegram.org") && s.problem).length;
  return !apiGetMeOk || (multiFail && webFails > 0);
}

async function handleScheduled(env) {
  const now = Date.now();
  const results = [];
  const signals = [];

  // 1) HARD: getMe
  let apiGetMeOk = false;
  const botToken = ENV.BOT_TOKEN;
  if (!botToken) {
    results.push("BOT_TOKEN missing");
    signals.push({ source: "getMe", problem: true, detail: "Missing BOT_TOKEN" });
    console.error("getMe: BOT_TOKEN is not set");
  } else {
    const getMeUrl = `https://api.telegram.org/bot${botToken}/getMe`;
    try {
      const start = Date.now();
      const r = await fetch(getMeUrl);
      const responseTime = Date.now() - start;
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok && responseTime <= ENV.MAX_RESPONSE_TIME_MS) {
        apiGetMeOk = true;
        results.push(`getMe OK (response time: ${responseTime}ms)`);
        signals.push({ source: "getMe", problem: false, detail: `status=${r.status}, time=${responseTime}ms` });
        console.log(`getMe: Success, status=${r.status}, time=${responseTime}ms`);
      } else {
        results.push(`getMe FAIL (status: ${r.status}, time: ${responseTime}ms)`);
        signals.push({ source: "getMe", problem: true, detail: `status=${r.status}, time=${responseTime}ms` });
        console.warn(`getMe: Failed, status=${r.status}, time=${responseTime}ms`);
      }
    } catch (e) {
      results.push(`getMe ERROR: ${e.message}`);
      signals.push({ source: "getMe", problem: true, detail: `error=${e.message}` });
      console.error(`getMe: Error - ${e.message}`);
    }
  }

  // 2) Multi-location check (check-host.net)
  let multiFail = false;
  try {
    const hostParam = encodeURIComponent("https://api.telegram.org");
    const start = Date.now();
    const r = await fetch(`https://check-host.net/check-http?host=${hostParam}&max_nodes=${ENV.CHECK_HOST_MAX_NODES}`);
    const responseTime = Date.now() - start;
    const j = await r.json();
    const requestId = j.request_id;
    const res = await fetch(`https://check-host.net/check-result-extended/${requestId}`);
    const resj = await res.json();
    let failCount = 0;
    for (const node of Object.values(resj.results || {})) {
      if (Array.isArray(node) && node[0][0] !== 1) failCount++;
    }
    multiFail = failCount >= ENV.CHECK_HOST_FAIL_NODES || responseTime > ENV.MAX_RESPONSE_TIME_MS;
    results.push(`check-host nodes fail=${failCount}, time=${responseTime}ms`);
    signals.push({ source: "check-host", problem: multiFail, detail: `fail=${failCount}, time=${responseTime}ms` });
    console.log(`check-host: failCount=${failCount}, time=${responseTime}ms`);
  } catch (e) {
    results.push(`check-host ERROR: ${e.message}`);
    signals.push({ source: "check-host", problem: true, detail: `error=${e.message}` });
    console.error(`check-host: Error - ${e.message}`);
  }

  // 3) web.telegram.org quick fetch
  let webFails = 0;
  const webTargets = ["https://web.telegram.org/", "https://telegram.org/"];
  for (const url of webTargets) {
    try {
      const start = Date.now();
      const r = await fetch(url);
      const responseTime = Date.now() - start;
      if (!r.ok || responseTime > ENV.MAX_RESPONSE_TIME_MS) {
        webFails++;
        signals.push({ source: url, problem: true, detail: `status=${r.status}, time=${responseTime}ms` });
        console.warn(`Web check (${url}): Failed, status=${r.status}, time=${responseTime}ms`);
      } else {
        signals.push({ source: url, problem: false, detail: `status=${r.status}, time=${responseTime}ms` });
        console.log(`Web check (${url}): Success, status=${r.status}, time=${responseTime}ms`);
      }
    } catch (e) {
      webFails++;
      signals.push({ source: url, problem: true, detail: `error=${e.message}` });
      console.error(`Web check (${url}): Error - ${e.message}`);
    }
  }

  // DECISION
  const shouldAlert = testShouldAlert(signals);

  // KV state
  let state = null;
  try {
    const raw = await env.STATUS_KV.get(KEY_ALERT);
    state = raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("KV read error:", e.message);
    state = null;
  }
  const prevAlert = state && state.alerting;
  let consecutiveFails = state && state.consecutiveFails ? state.consecutiveFails : 0;
  consecutiveFails = shouldAlert ? consecutiveFails + 1 : 0;
  const willAlert = consecutiveFails >= ENV.MIN_CONSECUTIVE_FAILURES;

  // Send alerts to Mattermost and Telegram
  if (willAlert && !prevAlert) {
    const text = ["**⚠️ Telegram outage detected**", `Detected at: ${new Date(now).toISOString()}`];
    for (const s of signals) text.push(`• ${s.source}: ${s.problem ? "PROBLEM" : "ok"} (${s.detail})`);
    const message = text.join("\n");
    await sendMattermost(ENV.MATTERMOST_WEBHOOK, message);
    await sendTelegram(ENV.BOT_TOKEN, ENV.TEST_CHAT_ID, message);
    await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ alerting: true, since: now, consecutiveFails }));
    console.log("Alert sent: Telegram outage detected");
    return;
  }
  if (!willAlert && prevAlert) {
    const text = ["**✅ Telegram recovered**", `Recovered at: ${new Date(now).toISOString()}`];
    for (const s of signals) text.push(`• ${s.source}: ${s.problem ? "PROBLEM" : "ok"} (${s.detail})`);
    const message = text.join("\n");
    await sendMattermost(ENV.MATTERMOST_WEBHOOK, message);
    await sendTelegram(ENV.BOT_TOKEN, ENV.TEST_CHAT_ID, message);
    await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ alerting: false, since: now, consecutiveFails }));
    console.log("Alert sent: Telegram recovered");
    return;
  }
  await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ alerting: prevAlert || false, since: state && state.since ? state.since : now, consecutiveFails }));
  console.log(`State updated: alerting=${prevAlert || false}, consecutiveFails=${consecutiveFails}`);
}






