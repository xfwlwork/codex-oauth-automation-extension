const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createSmsApiHelpers } = require('../background/sms-api.js');

const smsApi = createSmsApiHelpers();

describe('sms-api response parsers', () => {
  describe('parseBalanceResponse', () => {
    it('parses successful balance response', () => {
      const result = smsApi.parseBalanceResponse('ACCESS_BALANCE:123.45');
      assert.deepStrictEqual(result, { balance: '123.45' });
    });

    it('parses balance with whitespace', () => {
      const result = smsApi.parseBalanceResponse('  ACCESS_BALANCE:100.00  ');
      assert.deepStrictEqual(result, { balance: '100.00' });
    });

    it('throws on error response', () => {
      assert.throws(() => smsApi.parseBalanceResponse('BAD_KEY'), /API Key 无效/);
    });
  });

  describe('parseNumberResponse', () => {
    it('parses successful number response', () => {
      const result = smsApi.parseNumberResponse('ACCESS_NUMBER:12345:+66842571240');
      assert.deepStrictEqual(result, { activationId: '12345', phoneNumber: '+66842571240' });
    });

    it('parses number with spaces', () => {
      const result = smsApi.parseNumberResponse('ACCESS_NUMBER:99:+66 84 257 1240');
      assert.deepStrictEqual(result, { activationId: '99', phoneNumber: '+66 84 257 1240' });
    });

    it('throws on NO_NUMBERS', () => {
      assert.throws(() => smsApi.parseNumberResponse('NO_NUMBERS'), /无可用手机号/);
    });

    it('throws on BAD_KEY', () => {
      assert.throws(() => smsApi.parseNumberResponse('BAD_KEY'), /API Key 无效/);
    });

    it('throws on MAX_ACTIVATIONS', () => {
      assert.throws(() => smsApi.parseNumberResponse('MAX_ACTIVATIONS'), /激活数量已达上限/);
    });

    it('throws on NO_BALANCE', () => {
      assert.throws(() => smsApi.parseNumberResponse('NO_BALANCE'), /余额不足/);
    });
  });

  describe('parseStatusResponse', () => {
    it('parses STATUS_WAIT_CODE (status=1)', () => {
      const result = smsApi.parseStatusResponse('STATUS_WAIT_CODE');
      assert.deepStrictEqual(result, { status: 'STATUS_WAIT_CODE' });
    });

    it('parses STATUS_OK with code', () => {
      const result = smsApi.parseStatusResponse('STATUS_OK:123456');
      assert.deepStrictEqual(result, { status: 'STATUS_OK', code: '123456' });
    });

    it('parses numeric status with code', () => {
      const result = smsApi.parseStatusResponse('STATUS:3:123456');
      assert.deepStrictEqual(result, { status: '3', code: '123456' });
    });

    it('parses status without code', () => {
      const result = smsApi.parseStatusResponse('STATUS_WAIT_RETRY');
      assert.deepStrictEqual(result, { status: 'STATUS_WAIT_RETRY' });
    });

    it('throws on unknown response', () => {
      assert.throws(() => smsApi.parseStatusResponse('BAD_KEY'), /API Key 无效/);
    });
  });

  describe('parseSetStatusResponse', () => {
    it('parses ACCESS_READY', () => {
      const result = smsApi.parseSetStatusResponse('ACCESS_READY');
      assert.deepStrictEqual(result, { status: 'ACCESS_READY' });
    });

    it('normalizes to uppercase', () => {
      const result = smsApi.parseSetStatusResponse('access_ready');
      assert.deepStrictEqual(result, { status: 'ACCESS_READY' });
    });

    it('normalizes BAD_STATUS as-is (error handling done by caller)', () => {
      const result = smsApi.parseSetStatusResponse('BAD_STATUS');
      assert.deepStrictEqual(result, { status: 'BAD_STATUS' });
    });
  });

  describe('parseErrorResponse', () => {
    it('identifies NO_NUMBERS', () => {
      const err = smsApi.parseErrorResponse('NO_NUMBERS');
      assert.ok(err.message.includes('无可用手机号'));
    });

    it('identifies BAD_KEY', () => {
      const err = smsApi.parseErrorResponse('BAD_KEY');
      assert.ok(err.message.includes('API Key 无效'));
    });

    it('identifies MAX_ACTIVATIONS', () => {
      const err = smsApi.parseErrorResponse('MAX_ACTIVATIONS');
      assert.ok(err.message.includes('激活数量'));
    });

    it('identifies NO_BALANCE', () => {
      const err = smsApi.parseErrorResponse('NO_BALANCE');
      assert.ok(err.message.includes('余额不足'));
    });

    it('identifies BAD_ACTION', () => {
      const err = smsApi.parseErrorResponse('BAD_ACTION');
      assert.ok(err.message.includes('参数有误'));
    });

    it('identifies BAD_STATUS', () => {
      const err = smsApi.parseErrorResponse('BAD_STATUS');
      assert.ok(err.message.includes('状态码有误'));
    });

    it('returns generic error for unknown response', () => {
      const err = smsApi.parseErrorResponse('SOMETHING_WEIRD');
      assert.ok(err.message.includes('未知响应'));
    });
  });
});

describe('sms-api module exports', () => {
  it('exports createSmsApiHelpers', () => {
    assert.ok(typeof createSmsApiHelpers === 'function');
  });

  it('creates helpers with all expected functions', () => {
    const helpers = createSmsApiHelpers();
    assert.ok(typeof helpers.getBalance === 'function');
    assert.ok(typeof helpers.acquirePhoneNumber === 'function');
    assert.ok(typeof helpers.pollForCode === 'function');
    assert.ok(typeof helpers.completeActivation === 'function');
    assert.ok(typeof helpers.cancelActivation === 'function');
    assert.ok(typeof helpers.parseBalanceResponse === 'function');
    assert.ok(typeof helpers.parseNumberResponse === 'function');
    assert.ok(typeof helpers.parseStatusResponse === 'function');
    assert.ok(typeof helpers.parseSetStatusResponse === 'function');
    assert.ok(typeof helpers.parseErrorResponse === 'function');
  });

  it('provides default constants', () => {
    const helpers = createSmsApiHelpers();
    assert.strictEqual(helpers.DEFAULT_BASE_URL, 'https://hero-sms.com/stubs/handler_api.php');
    assert.strictEqual(helpers.DEFAULT_COUNTRY, 52);
    assert.strictEqual(helpers.DEFAULT_SERVICE, 'dr');
  });
});

describe('sms-api V2 response parsers', () => {
  describe('parseV2NumberResponse', () => {
    it('parses flat HeroSMS format with activationId and phoneNumber at top level', () => {
      const result = smsApi.parseV2NumberResponse(
        '{"activationId":"282399370","phoneNumber":"66952816097","activationCost":0.05,"currency":840,"countryCode":52,"countryPhoneCode":66,"canGetAnotherSms":true,"activationTime":"2026-04-17 10:49:30","activationEndTime":"2026-04-17 11:09:30","activationOperator":"truemove","serviceCode":"dr","subtype":1}'
      );
      assert.deepStrictEqual(result, { activationId: '282399370', phoneNumber: '66952816097' });
    });

    it('parses wrapped legacy format with code and data wrapper', () => {
      const result = smsApi.parseV2NumberResponse(
        '{"code":"OK","data":{"activationId":"12345","phoneNumber":"+66842571240"}}'
      );
      assert.deepStrictEqual(result, { activationId: '12345', phoneNumber: '+66842571240' });
    });

    it('falls back to legacy parsing for non-JSON', () => {
      const result = smsApi.parseV2NumberResponse('ACCESS_NUMBER:12345:+66842571240');
      assert.deepStrictEqual(result, { activationId: '12345', phoneNumber: '+66842571240' });
    });

    it('throws on error responses like NO_NUMBERS', () => {
      assert.throws(() => smsApi.parseV2NumberResponse('NO_NUMBERS'), /无可用手机号/);
    });

    it('throws on unknown JSON without activationId', () => {
      assert.throws(() => smsApi.parseV2NumberResponse('{"some":"thing"}'), /未知响应/);
    });
  });

  describe('parseV2StatusResponse', () => {
    it('parses V2 SMS received format with sms.code', () => {
      const result = smsApi.parseV2StatusResponse(
        '{"verificationType":2,"sms":{"dateTime":"2026-04-17 10:49:30","code":"123456","text":"sms text"}}'
      );
      assert.deepStrictEqual(result, { status: 'STATUS_OK', code: '123456' });
    });

    it('parses V2 call received format with call.code', () => {
      const result = smsApi.parseV2StatusResponse(
        '{"verificationType":2,"call":{"from":"phone","code":"98765","dateTime":"2026-04-17 10:49:30"}}'
      );
      assert.deepStrictEqual(result, { status: 'STATUS_OK', code: '98765' });
    });

    it('parses V2 waiting state (verificationType without sms.code) as STATUS_WAIT_CODE', () => {
      const result = smsApi.parseV2StatusResponse(
        '{"verificationType":2}'
      );
      assert.deepStrictEqual(result, { status: 'STATUS_WAIT_CODE' });
    });

    it('parses wrapped legacy format with code: STATUS_OK', () => {
      const result = smsApi.parseV2StatusResponse(
        '{"code":"STATUS_OK","sms":{"code":"111222"}}'
      );
      assert.deepStrictEqual(result, { status: 'STATUS_OK', code: '111222' });
    });

    it('parses STATUS_CANCEL string response', () => {
      const result = smsApi.parseV2StatusResponse('STATUS_CANCEL');
      assert.deepStrictEqual(result, { status: 'STATUS_CANCEL' });
    });

    it('parses numeric status code', () => {
      const result = smsApi.parseV2StatusResponse('STATUS:3:654321');
      assert.deepStrictEqual(result, { status: '3', code: '654321' });
    });

    it('throws on unknown JSON without recognizable status', () => {
      assert.throws(() => smsApi.parseV2StatusResponse('{"some":"thing"}'), /未知响应/);
    });
  });

  describe('parseV2ActivationsResponse', () => {
    it('parses V2 flat format with status: success and data array', () => {
      const result = smsApi.parseV2ActivationsResponse(
        '{"status":"success","data":[{"activationId":"635468021","serviceCode":"vk","phoneNumber":"79********1","activationCost":12.5,"activationStatus":"4","smsCode":"12345"}]}'
      );
      assert.deepStrictEqual(result, {
        activations: [{ activationId: '635468021', serviceCode: 'vk', phoneNumber: '79********1', activationCost: 12.5, activationStatus: '4', smsCode: '12345' }],
      });
    });

    it('parses wrapped legacy format with code: STATUS_OK and activations array', () => {
      const result = smsApi.parseV2ActivationsResponse(
        '{"code":"STATUS_OK","activations":[{"id":"123"}]}'
      );
      assert.deepStrictEqual(result, { activations: [{ id: '123' }] });
    });

    it('throws on error response like BAD_KEY', () => {
      assert.throws(() => smsApi.parseV2ActivationsResponse('BAD_KEY'), /API Key 无效/);
    });
  });
});
