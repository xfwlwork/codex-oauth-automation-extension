(function attachSmsPhoneFlow(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageSmsPhoneFlow = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSmsPhoneFlowModule() {
  const PHONE_VERIFICATION_URL_PATTERN = /\/phone-verification(?:[\/?#]|$)/i;
  const PHONE_VERIFICATION_SUBMIT_RETRY_MS = 30000;
  const CODE_POLL_TIMEOUT_MS = 240000;
  const CODE_POLL_INTERVAL_MS = 6000;
  const PHONE_ACQUIRE_MAX_RETRIES = 3;
  const PHONE_ACQUIRE_RETRY_DELAY_MS = 2000;
  const PHONE_CODE_WRONG_ERROR_PATTERN = /验证码错误|验证码不正确|代码不正确|code\s+is\s+incorrect|invalid\s+code|incorrect\s+code|请重试/i;
  const MAX_CODE_RETRY_COUNT = 3;
  const PHONE_NUMBER_ERROR_PATTERN = /phone_max_usage_exceeded|验证过程中出错.*phone|请重试/i;
  const FIRST_CODE_SUBMIT_DELAY_MS = 4000;

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

    async function executeSmsPhoneFlow(signupTabId) {
      if (!await isSmsPhoneConfigured()) {
        throw new Error('SMS 接码流程未配置，请先在侧边栏配置 HeroSMS API Key。');
      }

      const { apiKey, baseUrl, country, maxPrice } = await getSmsApiConfig();
      let activationId = null;

      try {
        // Step 1: Check for existing active activations that can be reused
        let phoneNumber = null;
        try {
          const activations = await smsApi.getActiveActivations(apiKey, baseUrl);
          if (activations && activations.activations && activations.activations.length > 0) {
            // Reuse the first active activation for the same country
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

        // Step 2: Acquire new phone number if no reusable one found
        if (!activationId || !phoneNumber) {
          let phoneResult;
          let acquireRetries = 0;

          while (acquireRetries < PHONE_ACQUIRE_MAX_RETRIES) {
            throwIfStopped();
            if (acquireRetries > 0) {
              await addLog(`SMS 手机号流程：第 ${acquireRetries + 1} 次尝试获取手机号...`, 'info');
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
                acquireRetries++;
                continue;
              }
              // BAD_KEY, NO_BALANCE, etc. — throw immediately
              throw err;
            }
          }

          if (!phoneResult) {
            throw new Error('SMS 手机号流程：多次尝试后仍无法获取手机号。');
          }

          activationId = phoneResult.activationId;
          phoneNumber = phoneResult.phoneNumber;
        }

        await addLog(`SMS 手机号流程：已获取手机号 ${phoneNumber}（激活ID: ${activationId}）`, 'info');

        // Step 3: Fill phone number and submit (with retry on phone_max_usage_exceeded)
        let submitResult;

        while (true) {
          submitResult = await sendToContentScriptResilient('signup-page', {
            type: 'FILL_PHONE_NUMBER',
            source: 'background',
            payload: { phoneNumber },
          }, {
            timeoutMs: PHONE_VERIFICATION_SUBMIT_RETRY_MS,
            retryDelayMs: 600,
            logMessage: 'SMS 手机号流程：正在等待内容脚本重新就绪...',
          });

          if (submitResult?.errorText && PHONE_NUMBER_ERROR_PATTERN.test(submitResult.errorText)) {
            await addLog(`SMS 手机号流程：手机号被拒绝：${submitResult.errorText}，正在取消激活...`, 'warn');
            await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => { });

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

            // Re-acquire phone number
            let phoneResult;
            let acquireRetries = 0;

            while (acquireRetries < PHONE_ACQUIRE_MAX_RETRIES) {
              throwIfStopped();
              if (acquireRetries > 0) {
                await addLog(`SMS 手机号流程：第 ${acquireRetries + 1} 次尝试获取手机号...`, 'info');
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
                  acquireRetries++;
                  continue;
                }
                throw err;
              }
            }

            if (!phoneResult) {
              throw new Error('SMS 手机号流程：多次尝试后仍无法获取新手机号。');
            }

            activationId = phoneResult.activationId;
            phoneNumber = phoneResult.phoneNumber;
            await addLog(`SMS 手机号流程：已重新获取手机号 ${phoneNumber}（激活ID: ${activationId}）`, 'info');
            // Retry phone submission loop
            continue;
          }

          break;
        }

        await addLog('SMS 手机号流程：手机号已提交，等待跳转到验证码页面...', 'info');

        // Step 4: Wait for redirect to phone-verification page
        const redirected = await waitForPhoneVerificationPage(signupTabId);
        if (!redirected) {
          throw new Error('SMS 手机号流程：提交手机号后未跳转到验证码页面，请检查页面是否正常。');
        }

        await addLog('SMS 手机号流程：已进入验证码页面，开始轮询短信验证码（V2 API）...', 'info');
        // Step 5: Delay before first code submission to allow SMS to arrive
        await addLog(`SMS 手机号流程：等待 ${(FIRST_CODE_SUBMIT_DELAY_MS / 1000).toFixed(0)} 秒后首次获取验证码，确保短信已送达...`, 'info');
        await sleepWithStop(FIRST_CODE_SUBMIT_DELAY_MS);

        // Step 5: Poll for verification code using V2 API
        const codeResult = await smsApi.pollForCodeV2(apiKey, baseUrl, activationId, {
          timeoutMs: CODE_POLL_TIMEOUT_MS,
          pollIntervalMs: CODE_POLL_INTERVAL_MS,
          throwIfStopped,
        });

        const code = codeResult.code;
        await addLog(`SMS 手机号流程：已获取验证码 ${code}`, 'info');


        // Step 6: Fill verification code and submit (with retry on wrong code)
        let lastCode = code;
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
            break;
          }

          if (!PHONE_CODE_WRONG_ERROR_PATTERN.test(fillResult.errorText) || codeRetryCount >= MAX_CODE_RETRY_COUNT) {
            await addLog(`SMS 手机号流程：验证码被拒绝：${fillResult.errorText}，正在取消激活...`, 'error');
            throw new Error(`SMS 手机号验证失败：${fillResult.errorText}`);
          }

          codeRetryCount++;
          await addLog(`SMS 手机号流程：验证码 ${lastCode} 错误（${fillResult.errorText}），正在等待新验证码（第 ${codeRetryCount}/${MAX_CODE_RETRY_COUNT} 次）...`, 'warn');

          const newCodeResult = await smsApi.waitForNewCodeV2(apiKey, baseUrl, activationId, lastCode, {
            timeoutMs: CODE_POLL_TIMEOUT_MS,
            pollIntervalMs: CODE_POLL_INTERVAL_MS,
            throwIfStopped,
          });

          lastCode = newCodeResult.code;
          await addLog(`SMS 手机号流程：已获取新验证码 ${lastCode}`, 'info');
        }

        await addLog('SMS 手机号流程：验证码已提交，正在等待页面跳转...', 'info');

        // Step 7: Wait for page to navigate away from phone-verification
        await sleepWithStop(3000);

        // Step 8: Complete activation
        // await smsApi.completeActivation(apiKey, baseUrl, activationId);

        await addLog('SMS 手机号验证已完成，正在继续 OAuth 授权流程...', 'ok');

        return { phoneNumber, activationId, code: lastCode };
      } catch (err) {
        if (activationId) {
          await smsApi.cancelActivation(apiKey, baseUrl, activationId).catch(() => { });
        }
        throw err;
      }
    }

    return { executeSmsPhoneFlow };
  }

  return { createSmsPhoneFlow };
});
