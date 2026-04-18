const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

const bundle = [
  extractFunction('isAddPhoneAuthUrl'),
  extractFunction('isAddPhoneAuthState'),
  extractFunction('isSmsPhoneConfigured'),
  extractFunction('getPostStep6AutoRestartDecision'),
  extractFunction('runAutoSequenceFromStep'),
].join('\n');

function createHarness(options = {}) {
  const {
    startStep = 6,
    failureStep = 9,
    failureBudget = 1,
    failureMessage = '认证失败: Request failed with status code 502',
    authState = { state: 'password_page', url: 'https://auth.openai.com/log-in' },
    smsConfigured = false,
  } = options;

  return new Function(`
const AUTO_STEP_DELAYS = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
const LOG_PREFIX = '[test]';
const POST_STEP6_MAX_RESTARTS = 3;
const chrome = {
  tabs: {
    update: async () => {},
  },
};

let remainingFailures = ${JSON.stringify(failureBudget)};
const events = {
  steps: [],
  logs: [],
  invalidations: [],
};

async function addLog(message, level = 'info') {
  events.logs.push({ message, level });
}

async function ensureAutoEmailReady() {}
async function broadcastAutoRunStatus() {}
async function getState() {
  return {
    stepStatuses: { 3: 'completed' },
    mailProvider: '163',
    ${smsConfigured ? "smsProvider: 'hero-sms', heroSmsApiKey: 'test-key'," : ''}
  };
}
function isStepDoneStatus(status) {
  return status === 'completed' || status === 'manual_completed' || status === 'skipped';
}
async function executeStepAndWait(step) {
  events.steps.push(step);
  if (step === ${JSON.stringify(failureStep)} && remainingFailures > 0) {
    remainingFailures -= 1;
    throw new Error(${JSON.stringify(failureMessage)});
  }
}
async function getTabId() {
  return 1;
}
function shouldSkipLoginVerificationForCpaCallback() {
  return false;
}
async function invalidateDownstreamAfterStepRestart(step, options = {}) {
  events.invalidations.push({ step, options });
}
function getLoginAuthStateLabel(state) {
  return state || 'unknown';
}
function getErrorMessage(error) {
  return error?.message || String(error || '');
}
async function getLoginAuthStateFromContent() {
  return ${JSON.stringify(authState)};
}

${bundle}

return {
  async run() {
    await runAutoSequenceFromStep(${JSON.stringify(startStep)}, {
      targetRun: 1,
      totalRuns: 1,
      attemptRuns: 1,
      continued: false,
    });
    return events;
  },
  async runAndCaptureError() {
    try {
      await runAutoSequenceFromStep(${JSON.stringify(startStep)}, {
        targetRun: 1,
        totalRuns: 1,
        attemptRuns: 1,
        continued: false,
      });
      return null;
    } catch (error) {
      return { error, events };
    }
  },
};
`)();
}

test('auto-run restarts from step 6 up to POST_STEP6_MAX_RESTARTS times then throws', async () => {
  const harness = createHarness({
    failureStep: 9,
    failureBudget: 10,
    failureMessage: '认证失败: Request failed with status code 502',
    authState: { state: 'password_page', url: 'https://auth.openai.com/log-in' },
  });

  const result = await harness.runAndCaptureError();

  assert.ok(result?.error);
  // 3 restarts allowed, so 3 invalidations + 1 final throw
  assert.equal(result.events.invalidations.length, 3);
  // Initial run: 6,7,8,9 (fails) → restart 1: 6,7,8,9 (fails) → restart 2: 6,7,8,9 (fails) → restart 3: 6,7,8,9 (fails, exceeds cap, throws)
  assert.deepStrictEqual(
    result.events.steps,
    [
      6, 7, 8, 9,
      6, 7, 8, 9,
      6, 7, 8, 9,
      6, 7, 8, 9,
    ]
  );
  assert.ok(result.events.logs.some(({ message }) => /回到步骤 6 重新开始授权流程/.test(message)));
  assert.ok(result.events.logs.some(({ message }) => /已回到步骤 6 重开 3 次仍失败，停止重开/.test(message)));
});

test('auto-run stops restarting once add-phone is detected', async () => {
  const harness = createHarness({
    failureStep: 6,
    failureBudget: 1,
    failureMessage: '当前页面已进入手机号页。URL: https://auth.openai.com/add-phone',
    authState: { state: 'add_phone_page', url: 'https://auth.openai.com/add-phone' },
  });

  const result = await harness.runAndCaptureError();

  assert.ok(result?.error);
  assert.equal(result.events.invalidations.length, 0);
  assert.deepStrictEqual(result.events.steps, [6]);
  assert.ok(result.events.logs.some(({ message }) => /进入 add-phone/.test(message)));
});

test('auto-run stops restarting on phone_max_usage_exceeded when SMS is configured', async () => {
  const harness = createHarness({
    failureStep: 8,
    failureBudget: 1,
    failureMessage: 'SMS 手机号流程（重试）：多次尝试后仍无法获取手机号。原因：3次尝试后仍无法获取手机号（无可用号码）。',
    authState: { state: 'add_phone_page', url: 'https://auth.openai.com/add-phone' },
    smsConfigured: true,
  });

  const result = await harness.runAndCaptureError();

  assert.ok(result?.error);
  assert.equal(result.events.invalidations.length, 0);
  assert.deepStrictEqual(result.events.steps, [6, 7, 8]);
  assert.ok(result.events.logs.some(({ message }) => /进入 add-phone/.test(message)));
  assert.ok(result.events.logs.some(({ message }) => /账号级 SMS 限制/.test(message)));
  assert.ok(!result.events.logs.some(({ message }) => /回到步骤 6 重新开始授权流程/.test(message)));
});

test('auto-run still restarts from step 6 on non-SMS errors when SMS is configured', async () => {
  const harness = createHarness({
    failureStep: 8,
    failureBudget: 10,
    failureMessage: '步骤 8：长时间未进入 OAuth 同意页，无法定位"继续"按钮。',
    authState: { state: 'consent_page', url: 'https://auth.openai.com/oauth/authorize' },
    smsConfigured: true,
  });

  const result = await harness.runAndCaptureError();

  assert.ok(result?.error);
  assert.equal(result.events.invalidations.length, 3);
  assert.ok(result.events.logs.some(({ message }) => /回到步骤 6 重新开始授权流程/.test(message)));
});
