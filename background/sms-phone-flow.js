(function attachSmsPhoneFlow(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageSmsPhoneFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSmsPhoneFlowModule() {
  const PHONE_VERIFICATION_URL_PATTERN = /\/phone-verification(?:[\/?#]|$)/i;
  const PHONE_VERIFICATION_SUBMIT_RETRY_MS = 30000;
  const CODE_POLL_TIMEOUT_MS = 30000;
  const CODE_POLL_INTERVAL_MS = 3000;
  const PHONE_ACQUIRE_MAX_RETRIES = 3;
  const PHONE_ACQUIRE_RETRY_DELAY_MS = 2000;
  const PHONE_CODE_WRONG_ERROR_PATTERN = /验证码错误|验证码不正确|代码不正确|code\s+is\s+incorrect|invalid\s+code|incorrect\s+code|请重试/i;
  const PHONE_NUMBER_ERROR_PATTERN = /phone_max_usage_exceeded|验证过程中出错.*phone|请重试/i;
  const FIRST_CODE_SUBMIT_DELAY_MS = 4000;
  const PHONE_NUMBER_MAX_SWAP_ATTEMPTS = 3;
  const MAX_CODE_RETRY_COUNT = 3;
  const ADD_PHONE_URL = 'https://auth.openai.com/add-phone';

  function createSmsPhoneFlow(deps = {}) {
    const {
      addLog,
      throwIfStopped,
      sleepWithStop,
      smsApi,
      sendToContentScriptResilient,
      chrome,
      isSmsPhoneConfigured,
      getSmsApiConfig,
    } = deps;

    async function waitForPhoneVerificationPage(tabId, timeoutMs = 30000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && PHONE_VERIFICATION_URL_PATTERN.test(tab.url || '')) {
          return true;
        }
        await sleepWithStop(500);
      }
      return false;
    }

    async function acquirePhone(apiKey, baseUrl, country, maxPrice, label = '') {
      let phoneResult;
      let acquireRetries = 0;

      while (acquireRetries < PHONE_ACQUIRE_MAX_RETRIES) {
        throwIfStopped();
        if (acquireRetries > 0) {
          await addLog(`SMS 手机号流程${label}：第 ${acquireRetries + 1} 次尝试获取手机号...`, 'info');
          await sleepWithStop(PHONE_ACQUIRE_RETRY_DELAY_MS);
        }

        try {
          phoneResult = await smsApi.getNumberV2(apiKey, baseUrl, country, undefined, {
            maxPrice: maxPrice !== undefined && maxPrice !== '' ? maxPrice : 0.05,
          });
          break;
        } catch (err) {
          const msg = String(err.message || err);
          if (/无可用手机号/.test(msg)) {
            await addLog(`SMS 手机号流程${label}：第 ${acquireRetries + 1} 次尝试失败（${msg}），正在重试...`, 'warn');
            acquireRetries++;
            continue;
          }
          throw err;
        }
      }

      if (!phoneResult) {
        throw new Error(`SMS 手机号流程${label}：${PHONE_ACQUIRE_MAX_RETRIES}次尝试后仍无法获取手机号（无可用号码）。`);
      }

      return phoneResult;
    }

    async function submitPhoneToPage(phoneNumber) {
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'FILL_PHONE_NUMBER',
        source: 'background',
        payload: { phoneNumber },
      }, {
        timeoutMs: PHONE_VERIFICATION_SUBMIT_RETRY_MS,
        retryDelayMs: 600,
        logMessage: 'SMS 手机号流程：正在等待内容脚本重新就绪...',
      });
      return result;
    }

    async function navigateToAddPhone(tabId) {
      await addLog(`SMS 手机号流程：正在跳转到 ${ADD_PHONE_URL}...`, 'info');
      await chrome.tabs.update(tabId, { url: ADD_PHONE_URL });

      const start = Date.now();
      while (Date.now() - start < 15000) {
        throwIfStopped();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && /\/add-phone(?:[/?#]|$)/i.test(tab.url || '')) {
          break;
        }
        await sleepWithStop(500);
      }

      await sleepWithStop(1000);
    }

    async function executeSmsPhoneFlow(signupTabId) {
      if (!await isSmsPhoneConfigured()) {
        throw new Error('SMS 接码流程未配置，请先在侧边栏配置 HeroSMS API Key。');
      }

      const { apiKey, baseUrl, country, maxPrice } = await getSmsApiConfig();
      let activationId = null;
      let phoneNumber = null;
      let lastCode = null;

      try {
        // -- Initial phone acquisition (first attempt or reuse existing activation) --
        try {
          const activations = await smsApi.getActiveActivations(apiKey, baseUrl);
          if (activations && activations.activations && activations.activations.length > 0) {
            const matching = activations.activations.find(
              (a) => String(a.countryCode) === String(country)
            ) || activations.activations[0];
            activationId = matching.activationId;
            phoneNumber = matching.phoneNumber;
            await addLog(`SMS 手机号流程：发现现有激活 ${activationId}（手机号: ${phoneNumber}），正在复用...`, 'info');
            try {
              await smsApi.completeActivation(apiKey, baseUrl, activationId, 3);
              await addLog(`SMS 手机号流程：已成功复用激活 ${activationId}，手机号 ${phoneNumber} 已标记为完成。`, 'info');
            } catch (err) {
              await addLog(`SMS 手机号流程：复用激活 ${activationId} 失败（${err.message || err}），将尝试获取新手机号...`, 'warn');
              activationId = null;
              phoneNumber = null;
            }
          }
        } catch (err) {
          await addLog(`SMS 手机号流程：检查现有激活失败（${err.message || err}），正在获取新手机号...`, 'warn');
        }

        if (!activationId || !phoneNumber) {
          const phoneResult = await acquirePhone(apiKey, baseUrl, country, maxPrice);
          activationId = phoneResult.activationId;
          phoneNumber = phoneResult.phoneNumber;
        }

        await addLog(`SMS 手机号流程：已获取手机号 ${phoneNumber}（激活ID: ${activationId}）`, 'info');

        // -- Outer loop: retry with new phone number when code polling times out --
        for (let attempt = 1; attempt <= PHONE_NUMBER_MAX_SWAP_ATTEMPTS + 1; attempt++) {
          throwIfStopped();

          // For retry attempts: cancel, navigate to add-phone, get new phone, submit
          if (attempt > 1) {
            await addLog(`第 ${attempt} 次尝试，正在更换手机号...`, 'warn');

            // 1. 取消当前激活
            if (activationId) {
              await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => {});
              await addLog('SMS 手机号流程：已取消当前激活', 'info');
            }

            // 2. 跳转到 add-phone 页面
            await navigateToAddPhone(signupTabId);

            // 3. 调用 HeroSMS 获取新手机号
            const phoneResult = await acquirePhone(apiKey, baseUrl, country, maxPrice, '（换号）');
            activationId = phoneResult.activationId;
            phoneNumber = phoneResult.phoneNumber;
            await addLog(`SMS 手机号流程：已获取手机号 ${phoneNumber}（激活ID: ${activationId}）`, 'info');

            // 4. FILL_PHONE_NUMBER → 填写新手机号并提交
            const submitResult = await submitPhoneToPage(phoneNumber);
            if (submitResult?.errorText && PHONE_NUMBER_ERROR_PATTERN.test(submitResult.errorText)) {
              await addLog(`SMS 手机号流程：新手机号被拒绝：${submitResult.errorText}`, 'warn');
              await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => {});
              if (attempt <= PHONE_NUMBER_MAX_SWAP_ATTEMPTS) {
                continue;
              }
              throw new Error(`SMS 手机号流程：${PHONE_NUMBER_MAX_SWAP_ATTEMPTS}次更换手机号后仍被拒绝。`);
            }

            // 5. 等待跳转到 phone-verification 页面
            await addLog('SMS 手机号流程：手机号已提交，等待跳转到验证码页面...', 'info');
            const redirected = await waitForPhoneVerificationPage(signupTabId);
            if (!redirected) {
              throw new Error('SMS 手机号流程：提交新手机号后未跳转到验证码页面。');
            }
          } else {
            // First attempt: normal phone submission
            let submitResult;
            let phoneRejectionRetries = 0;
            while (phoneRejectionRetries < PHONE_NUMBER_MAX_SWAP_ATTEMPTS) {
              submitResult = await submitPhoneToPage(phoneNumber);

              if (submitResult?.errorText && PHONE_NUMBER_ERROR_PATTERN.test(submitResult.errorText)) {
                phoneRejectionRetries++;
                await addLog(`SMS 手机号流程：手机号被拒绝：${submitResult.errorText}，正在取消激活并重新获取...`, 'warn');
                await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => {});

                // Click "Retry" to return to phone input page
                await sendToContentScriptResilient('signup-page', {
                  type: 'RETRY_PHONE_INPUT',
                  source: 'background',
                  payload: {},
                }, {
                  timeoutMs: 10000,
                  retryDelayMs: 600,
                  logMessage: 'SMS 手机号流程：正在等待重试按钮可用...',
                });

                try {
                  const phoneResult = await acquirePhone(apiKey, baseUrl, country, maxPrice, '（重试）');
                  activationId = phoneResult.activationId;
                  phoneNumber = phoneResult.phoneNumber;
                  await addLog(`SMS 手机号流程：已重新获取手机号 ${phoneNumber}（激活ID: ${activationId}）`, 'info');
                } catch (err) {
                  await addLog(`SMS 手机号流程（重试）：获取手机号失败（${err.message || err}）。`, 'error');
                  throw new Error(`SMS 手机号流程（重试）：多次尝试后仍无法获取手机号。原因：${err.message || err}`);
                }
                continue;
              }

              break;
            }

            await addLog('SMS 手机号流程：手机号已提交，等待跳转到验证码页面...', 'info');
            const redirected = await waitForPhoneVerificationPage(signupTabId);
            if (!redirected) {
              throw new Error('SMS 手机号流程：提交手机号后未跳转到验证码页面，请检查页面是否正常。');
            }
          }

          // 6. 轮询验证码（30s 超时）
          await addLog('SMS 手机号流程：已进入验证码页面，开始轮询短信验证码（V2 API）...', 'info');
          await addLog(`SMS 手机号流程：等待 ${(FIRST_CODE_SUBMIT_DELAY_MS / 1000).toFixed(0)} 秒后首次获取验证码，确保短信已送达...`, 'info');
          await sleepWithStop(FIRST_CODE_SUBMIT_DELAY_MS);

          try {
            const codeResult = await smsApi.pollForCodeV2(apiKey, baseUrl, activationId, {
              timeoutMs: CODE_POLL_TIMEOUT_MS,
              pollIntervalMs: CODE_POLL_INTERVAL_MS,
              throwIfStopped,
              addLog,
            });

            lastCode = codeResult.code;
            await addLog(`SMS 手机号流程：已获取验证码 ${lastCode}`, 'info');
          } catch (err) {
            if (attempt < PHONE_NUMBER_MAX_SWAP_ATTEMPTS + 1) {
              await addLog(`${err.message}，将尝试更换手机号...`, 'warn');
              continue;
            }
            throw err;
          }

          // -- Submit verification code --
          let codeSubmitSuccess = false;
          let codeRetryCount = 0;
          let fillResult;

          while (true) {
            fillResult = await sendToContentScriptResilient('signup-page', {
              type: 'FILL_PHONE_VERIFICATION_CODE',
              source: 'background',
              payload: { code: lastCode },
            }, {
              timeoutMs: PHONE_VERIFICATION_SUBMIT_RETRY_MS,
              retryDelayMs: 600,
              logMessage: 'SMS 手机号流程：正在等待内容脚本重新就绪...',
            });

            if (!fillResult?.errorText) {
              codeSubmitSuccess = true;
              break;
            }

            if (PHONE_CODE_WRONG_ERROR_PATTERN.test(fillResult.errorText)) {
              codeRetryCount++;
              if (codeRetryCount >= MAX_CODE_RETRY_COUNT) {
                await addLog(`${MAX_CODE_RETRY_COUNT} 次验证码仍错误，将尝试更换手机号...`, 'warn');
              } else {
                await addLog(`验证码 ${lastCode} 错误（${fillResult.errorText}），正在等待新验证码（第 ${codeRetryCount}/${MAX_CODE_RETRY_COUNT} 次）...`, 'warn');

                const newCodeResult = await smsApi.waitForNewCodeV2(apiKey, baseUrl, activationId, lastCode, {
                  timeoutMs: CODE_POLL_TIMEOUT_MS,
                  pollIntervalMs: CODE_POLL_INTERVAL_MS,
                  throwIfStopped,
                  onPoll: (count, result) => {
                    addLog(`等待新验证码，第 ${count} 次轮询，状态: ${result.status}`, 'info');
                  },
                });

                lastCode = newCodeResult.code;
                await addLog(`已获取新验证码 ${lastCode}`, 'info');
                continue;
              }
            } else {
              await addLog(`SMS 手机号流程：验证码被拒绝：${fillResult.errorText}`, 'warn');
            }

            // Code submission failed → break to check if we should swap phone
            break;
          }

          if (codeSubmitSuccess) {
            await addLog('SMS 手机号流程：验证码已提交，正在等待页面跳转...', 'info');
            await sleepWithStop(8000);
            await addLog('SMS 手机号验证已完成，正在继续 OAuth 授权流程...', 'ok');

            return { phoneNumber, activationId, code: lastCode };
          }

          // Code submission failed → continue to next phone if attempts remain
          if (attempt < PHONE_NUMBER_MAX_SWAP_ATTEMPTS + 1) {
            await addLog('验证码提交失败，将尝试更换手机号...', 'warn');
            continue;
          }
          throw new Error(`SMS 手机号验证失败：${fillResult?.errorText || '验证码提交失败'}`);
        }

        throw new Error('SMS 手机号流程：所有换号尝试均已失败。');
      } catch (err) {
        if (activationId) {
          await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => {});
        }
        throw err;
      }
    }

    return { executeSmsPhoneFlow };
  }

  return { createSmsPhoneFlow };
});
