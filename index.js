export default {
  async scheduled(event, env, ctx) {
    try {
      ctx.waitUntil(handleScheduled(env));
    } catch (e) {
      console.error("Top-level scheduled error:", e.message, e.stack);
    }
  },
  
  async fetch(request, env, ctx) {
    try {
      const state = await env.STATUS_KV.get(KEY_ALERT);
      const stateObj = state ? JSON.parse(state) : { alerting: false };
      
      return new Response(JSON.stringify({
        status: "Telegram Monitor Active",
        alerting: stateObj.alerting,
        since: stateObj.since ? new Date(stateObj.since).toISOString() : null,
        consecutiveFails: stateObj.consecutiveFails || 0,
        lastCheck: new Date().toISOString()
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }
};

const KEY_ALERT = "tg_alert_state";

// Используем переменные окружения из wrangler.toml
function getEnvConfig(env) {
  return {
    MATTERMOST_WEBHOOK: "https://mm.mvpproject.io/hooks/1q715bsjzina5enz98x43bj7gc",
    BOT_TOKEN: "7564679631:AAFuJ4286u2r2EL-_0q7SgYmt_TdfdLoi2w",
    TEST_CHAT_ID: "855257187",
    MIN_CONSECUTIVE_FAILURES: parseInt(env.MIN_CONSECUTIVE_FAILURES || "2"),
    CHECK_HOST_MAX_NODES: parseInt(env.CHECK_HOST_MAX_NODES || "5"),
    CHECK_HOST_FAIL_NODES: parseInt(env.CHECK_HOST_FAIL_NODES || "2"),
    MAX_RESPONSE_TIME_MS: parseInt(env.MAX_RESPONSE_TIME_MS || "2000"),
  };
}

async function sendMattermost(webhook, text) {
  if (!webhook) {
    console.error("Mattermost webhook missing");
    return;
  }
  const payload = { 
    username: "tg-monitor", 
    icon_url: "https://telegram.org/img/t_logo.png", 
    text 
  };
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      console.log("Mattermost notification sent successfully");
    } else {
      console.warn("Mattermost notification failed:", response.status, response.statusText);
    }
  } catch (e) {
    console.error("Failed to post to Mattermost:", e.message, e.stack);
  }
}

async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) {
    console.error("Telegram botToken or chatId missing");
    return;
  }
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
      console.warn(`Telegram sendMessage failed: status=${r.status}, response=${JSON.stringify(j)}`);
    }
  } catch (e) {
    console.error(`Telegram sendMessage error: ${e.message}, stack=${e.stack}`);
  }
}

function testShouldAlert(signals) {
  const apiGetMeOk = !signals.find(s => s.source === "getMe" && s.problem);
  const multiFail = signals.find(s => s.source === "check-host" && s.problem);
  const webFails = signals.filter(s => 
    (s.source.includes("web.telegram.org") || s.source.includes("telegram.org")) && s.problem
  ).length;
  
  return !apiGetMeOk || (multiFail && webFails > 0);
}

async function checkHostStatus(config) {
  try {
    const hostParam = encodeURIComponent("https://api.telegram.org");
    const start = Date.now();
    
    // Делаем запрос на проверку
    const checkResponse = await fetch(
      `https://check-host.net/check-http?host=${hostParam}&max_nodes=${config.CHECK_HOST_MAX_NODES}`,
      { timeout: 10000 }
    );
    
    if (!checkResponse.ok) {
      throw new Error(`Check request failed: ${checkResponse.status}`);
    }
    
    const checkData = await checkResponse.json();
    const requestId = checkData.request_id;
    
    if (!requestId) {
      throw new Error("No request_id received");
    }
    
    // Ждем результат (добавляем задержку)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const resultResponse = await fetch(
      `https://check-host.net/check-result/${requestId}`,
      { timeout: 10000 }
    );
    
    if (!resultResponse.ok) {
      throw new Error(`Result request failed: ${resultResponse.status}`);
    }
    
    const resultData = await resultResponse.json();
    const responseTime = Date.now() - start;
    
    let failCount = 0;
    const results = resultData || {};
    
    for (const [node, result] of Object.entries(results)) {
      if (Array.isArray(result) && result.length > 0) {
        // Проверяем первый элемент - если не 1, то это ошибка
        if (result[0][0] !== 1) {
          failCount++;
        }
      } else {
        // Если нет результата, считаем как ошибку
        failCount++;
      }
    }
    
    const multiFail = failCount >= config.CHECK_HOST_FAIL_NODES || responseTime > config.MAX_RESPONSE_TIME_MS;
    
    return {
      failCount,
      responseTime,
      multiFail,
      totalNodes: Object.keys(results).length
    };
    
  } catch (e) {
    console.error(`check-host error: ${e.message}`);
    return {
      failCount: 999,
      responseTime: 0,
      multiFail: true,
      error: e.message
    };
  }
}

async function handleScheduled(env) {
  try {
    const config = getEnvConfig(env);
    const now = Date.now();
    const signals = [];

    console.log("Starting monitoring check...");

    // 1) Проверка API getMe
    let apiGetMeOk = false;
    const botToken = config.BOT_TOKEN;
    
    if (!botToken) {
      signals.push({ source: "getMe", problem: true, detail: "Missing BOT_TOKEN" });
      console.error("getMe: BOT_TOKEN is not set");
    } else {
      const getMeUrl = `https://api.telegram.org/bot${botToken}/getMe`;
      try {
        const start = Date.now();
        const r = await fetch(getMeUrl, { timeout: 10000 });
        const responseTime = Date.now() - start;
        const j = await r.json().catch(() => null);
        
        if (r.ok && j && j.ok && responseTime <= config.MAX_RESPONSE_TIME_MS) {
          apiGetMeOk = true;
          signals.push({ source: "getMe", problem: false, detail: `status=${r.status}, time=${responseTime}ms` });
          console.log(`getMe: Success, status=${r.status}, time=${responseTime}ms`);
        } else {
          signals.push({ source: "getMe", problem: true, detail: `status=${r.status}, time=${responseTime}ms` });
          console.warn(`getMe: Failed, status=${r.status}, time=${responseTime}ms`);
        }
      } catch (e) {
        signals.push({ source: "getMe", problem: true, detail: `error=${e.message}` });
        console.error(`getMe: Error - ${e.message}`);
      }
    }

    // 2) Проверка через check-host.net
    console.log("Checking via check-host.net...");
    const hostCheck = await checkHostStatus(config);
    
    signals.push({ 
      source: "check-host", 
      problem: hostCheck.multiFail, 
      detail: hostCheck.error || `fail=${hostCheck.failCount}/${hostCheck.totalNodes}, time=${hostCheck.responseTime}ms` 
    });

    // 3) Проверка веб-сайтов
    const webTargets = ["https://web.telegram.org/", "https://telegram.org/"];
    for (const url of webTargets) {
      try {
        const start = Date.now();
        const r = await fetch(url, { timeout: 10000 });
        const responseTime = Date.now() - start;
        
        if (!r.ok || responseTime > config.MAX_RESPONSE_TIME_MS) {
          signals.push({ source: url, problem: true, detail: `status=${r.status}, time=${responseTime}ms` });
          console.warn(`Web check (${url}): Failed, status=${r.status}, time=${responseTime}ms`);
        } else {
          signals.push({ source: url, problem: false, detail: `status=${r.status}, time=${responseTime}ms` });
          console.log(`Web check (${url}): Success, status=${r.status}, time=${responseTime}ms`);
        }
      } catch (e) {
        signals.push({ source: url, problem: true, detail: `error=${e.message}` });
        console.error(`Web check (${url}): Error - ${e.message}`);
      }
    }

    // Принятие решения об алерте
    const shouldAlert = testShouldAlert(signals);
    console.log(`Should alert: ${shouldAlert}`);

    // Работа с состоянием в KV
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
    const willAlert = consecutiveFails >= config.MIN_CONSECUTIVE_FAILURES;

    console.log(`Previous alert: ${prevAlert}, consecutive fails: ${consecutiveFails}, will alert: ${willAlert}`);

    // Отправка уведомлений
    if (willAlert && !prevAlert) {
      const text = [
        "**⚠️ Telegram outage detected**", 
        `Detected at: ${new Date(now).toISOString()}`
      ];
      for (const s of signals) {
        text.push(`• ${s.source}: ${s.problem ? "PROBLEM" : "ok"} (${s.detail})`);
      }
      const message = text.join("\n");
      
      await sendMattermost(config.MATTERMOST_WEBHOOK, message);
      await sendTelegram(config.BOT_TOKEN, config.TEST_CHAT_ID, message);
      
      try {
        await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ 
          alerting: true, 
          since: now, 
          consecutiveFails 
        }));
        console.log("Alert state saved: alerting=true");
      } catch (e) {
        console.error("KV write error:", e.message);
      }
      
      console.log("Alert sent: Telegram outage detected");
      return;
    }

    if (!willAlert && prevAlert) {
      const text = [
        "**✅ Telegram recovered**", 
        `Recovered at: ${new Date(now).toISOString()}`
      ];
      for (const s of signals) {
        text.push(`• ${s.source}: ${s.problem ? "PROBLEM" : "ok"} (${s.detail})`);
      }
      const message = text.join("\n");
      
      await sendMattermost(config.MATTERMOST_WEBHOOK, message);
      await sendTelegram(config.BOT_TOKEN, config.TEST_CHAT_ID, message);
      
      try {
        await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ 
          alerting: false, 
          since: now, 
          consecutiveFails 
        }));
        console.log("Recovery state saved: alerting=false");
      } catch (e) {
        console.error("KV write error:", e.message);
      }
      
      console.log("Alert sent: Telegram recovered");
      return;
    }

    // Обновляем состояние
    try {
      await env.STATUS_KV.put(KEY_ALERT, JSON.stringify({ 
        alerting: prevAlert || false, 
        since: state && state.since ? state.since : now, 
        consecutiveFails 
      }));
      console.log(`State updated: alerting=${prevAlert || false}, consecutiveFails=${consecutiveFails}`);
    } catch (e) {
      console.error("KV write error:", e.message);
    }

  } catch (e) {
    console.error("handleScheduled error:", e.message, e.stack);
  }
}









