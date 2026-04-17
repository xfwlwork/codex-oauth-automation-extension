(function attachSmsApi(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageSmsApi = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createSmsApiModule() {
  const DEFAULT_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const DEFAULT_COUNTRY = 52;
  const DEFAULT_SERVICE = 'dr';

  // -- Error codes from API --
  const ERR_NO_NUMBERS = 'NO_NUMBERS';
  const ERR_BAD_KEY = 'BAD_KEY';
  const ERR_MAX_ACTIVATIONS = 'MAX_ACTIVATIONS';
  const ERR_NO_BALANCE = 'NO_BALANCE';
  const ERR_BAD_STATUS = 'BAD_STATUS';
  const ERR_BAD_ACTION = 'BAD_ACTION';

  function normalizeUrl(base) {
    const raw = String(base || DEFAULT_BASE_URL).trim();
    return raw.replace(/\/+$/, '');
  }

  function buildUrl(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  async function apiGet(baseUrl, params, apiKey) {
    const url = buildUrl(baseUrl, { api_key: apiKey, ...params });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HeroSMS API 请求失败：HTTP ${response.status}`);
    }
    return response.text();
  }

  // -- Response parsers --

  function parseBalanceResponse(text) {
    const match = /^ACCESS_BALANCE:(.+)$/i.exec(text.trim());
    if (!match) {
      throw parseErrorResponse(text);
    }
    return { balance: match[1].trim() };
  }

  function parseNumberResponse(text) {
    const trimmed = text.trim();
    const match = /^ACCESS_NUMBER:([^:]+):(.+)$/i.exec(trimmed);
    if (!match) {
      throw parseErrorResponse(text);
    }
    return { activationId: match[1].trim(), phoneNumber: match[2].trim() };
  }

  function parseStatusResponse(text) {
    const trimmed = text.trim();

    // Numeric format: STATUS:<status_code>:<code> or STATUS:<status_code>
    if (/^STATUS:\d/.test(trimmed)) {
      const parts = trimmed.split(':');
      const result = { status: parts[1] };
      if (parts.length >= 3) {
        result.code = parts.slice(2).join(':').trim();
      }
      return result;
    }

    // Text-based format: STATUS_WAIT_CODE, STATUS_OK:123456, STATUS_CANCEL, etc.
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      return {
        status: trimmed.substring(0, colonIndex),
        code: trimmed.substring(colonIndex + 1).trim(),
      };
    }

    if (/^STATUS_/.test(trimmed) || trimmed === 'STATUS_OK' || trimmed === 'STATUS_CANCEL') {
      return { status: trimmed };
    }

    throw parseErrorResponse(text);
  }

  function parseSetStatusResponse(text) {
    const trimmed = text.trim().toUpperCase();
    return { status: trimmed };
  }

  function parseErrorResponse(text) {
    const trimmed = text.trim();
    switch (trimmed) {
      case ERR_NO_NUMBERS:
        return new Error('当前无可用手机号，请稍后重试。');
      case ERR_BAD_KEY:
        return new Error('HeroSMS API Key 无效，请检查配置。');
      case ERR_MAX_ACTIVATIONS:
        return new Error('当前同时进行的激活数量已达上限，请稍后重试。');
      case ERR_NO_BALANCE:
        return new Error('HeroSMS 余额不足。');
      case ERR_BAD_ACTION:
        return new Error('HeroSMS API 请求参数有误。');
      case ERR_BAD_STATUS:
        return new Error('HeroSMS 状态码有误。');
      default:
        return new Error(`HeroSMS 返回了未知响应：${trimmed}`);
    }
  }

  // -- High-level functions --

  // -- V2 API functions --

  function parseV2NumberResponse(text) {
    const trimmed = text.trim();
    try {
      const data = JSON.parse(trimmed);
      // V2 flat format (actual HeroSMS response): { activationId, phoneNumber, activationCost, ... }
      if (data.activationId && data.phoneNumber) {
        return {
          activationId: String(data.activationId),
          phoneNumber: String(data.phoneNumber),
        };
      }
      // Legacy wrapped format: { code, data: { activationId, phoneNumber } }
      if (data.code && data.data) {
        return {
          activationId: String(data.data.activationId),
          phoneNumber: String(data.data.phoneNumber),
        };
      }
    } catch {
      // Not JSON, fall back to legacy parsing
      return parseNumberResponse(text);
    }
    throw parseErrorResponse(text);
  }

  function parseV2StatusResponse(text) {
    const trimmed = text.trim();
    try {
      const data = JSON.parse(trimmed);
      // V2 flat format: { verificationType, sms: { code }, call: { code } }
      // SMS received when sms.code or call.code exists (verificationType 1=SMS, 2=call)
      if (data.sms && data.sms.code) {
        return { status: 'STATUS_OK', code: String(data.sms.code) };
      }
      if (data.call && data.call.code) {
        return { status: 'STATUS_OK', code: String(data.call.code) };
      }
      // Wrapped legacy format: { code: 'STATUS_OK', sms: { code } }
      if (data.code === 'STATUS_OK' && data.sms && data.sms.code) {
        return { status: 'STATUS_OK', code: String(data.sms.code) };
      }
      if (data.code) {
        return { status: data.code };
      }
      // V2 waiting state: { verificationType, ... } without sms.code means still waiting
      if (data.verificationType !== undefined) {
        return { status: 'STATUS_WAIT_CODE' };
      }
    } catch {
      // Not JSON, fall back to legacy parsing
      return parseStatusResponse(text);
    }
    throw parseErrorResponse(text);
  }

  function parseV2ActivationsResponse(text) {
    const trimmed = text.trim();
    // Check for known error codes first (these are plain strings, not JSON)
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      throw parseErrorResponse(trimmed);
    }
    try {
      const data = JSON.parse(trimmed);
      // V2 flat format: { status: 'success', data: [...] }
      if (data.status === 'success' && Array.isArray(data.data)) {
        return { activations: data.data };
      }
      // Wrapped legacy format: { code: 'STATUS_OK', activations: [...] }
      if (data.code === 'STATUS_OK' && Array.isArray(data.activations)) {
        return { activations: data.activations };
      }
      throw parseErrorResponse(trimmed);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('HeroSMS V2 getActiveActivations 返回了非 JSON 响应。');
      }
      throw err;
    }
  }

  async function getActiveActivations(apiKey, baseUrl, service) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const text = await apiGet(normalizedBaseUrl, {
      action: 'getActiveActivations',
      service: service || DEFAULT_SERVICE,
    }, apiKey);
    return parseV2ActivationsResponse(text);
  }

  async function getNumberV2(apiKey, baseUrl, country, service, options = {}) {
    const { maxPrice } = options;
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const params = {
      action: 'getNumberV2',
      service: service || DEFAULT_SERVICE,
      country: country || DEFAULT_COUNTRY,
    };
    if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
      params.maxPrice = String(maxPrice);
    }
    const text = await apiGet(normalizedBaseUrl, params, apiKey);
    return parseV2NumberResponse(text);
  }

  async function pollForCodeV2(apiKey, baseUrl, activationId, options = {}) {
    const {
      timeoutMs = 240000,
      pollIntervalMs = 5000,
      throwIfStopped = () => { },
    } = options;

    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      throwIfStopped();

      const text = await apiGet(normalizedBaseUrl, {
        action: 'getStatusV2',
        id: activationId,
      }, apiKey);

      const result = parseV2StatusResponse(text);

      // STATUS_OK with code: SMS received
      if (result.status === 'STATUS_OK' && result.code) {
      return { code: result.code, status: result.status };
      }

      // WAIT_CODE / STATUS_WAIT_CODE: still waiting
      if (result.status === 'WAIT_CODE' || result.status === 'STATUS_WAIT_CODE') {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      // Error statuses
      if (result.status === 'STATUS_CANCEL' || result.status === '8') {
        throw new Error('当前激活已被取消。');
      }
      if (result.status === 'EXPIRED' || result.status === '7') {
        throw new Error('当前激活已过期。');
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('等待短信验证码超时。');
  }

  async function waitForNewCodeV2(apiKey, baseUrl, activationId, previousCode, options = {}) {
    const {
      timeoutMs = 120000,
      pollIntervalMs = 5000,
      throwIfStopped = () => { },
    } = options;

    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      throwIfStopped();

      const text = await apiGet(normalizedBaseUrl, {
        action: 'getStatusV2',
        id: activationId,
      }, apiKey);

      const result = parseV2StatusResponse(text);

      // STATUS_OK with a different code: new SMS received
      if (result.status === 'STATUS_OK' && result.code && result.code !== previousCode) {
        return { code: result.code, status: result.status };
      }

      // Error statuses
      if (result.status === 'STATUS_CANCEL' || result.status === '8') {
        throw new Error('当前激活已被取消。');
      }
      if (result.status === 'EXPIRED' || result.status === '7') {
        throw new Error('当前激活已过期。');
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('等待新短信验证码超时。');
  }

  async function acquirePhoneNumber(apiKey, baseUrl, country, service) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const text = await apiGet(normalizedBaseUrl, {
      action: 'getNumber',
      service: service || DEFAULT_SERVICE,
      country: country || DEFAULT_COUNTRY,
    }, apiKey);
    return parseNumberResponse(text);
  }

  async function pollForCode(apiKey, baseUrl, activationId, options = {}) {
    const {
      timeoutMs = 120000,
      pollIntervalMs = 3000,
      throwIfStopped = () => { },
    } = options;

    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      throwIfStopped();

      const text = await apiGet(normalizedBaseUrl, {
        action: 'getStatus',
        id: activationId,
      }, apiKey);

      const result = parseStatusResponse(text);

      // status=3: SMS received, code is available
      if (result.status === 'STATUS_OK' || result.status === '3') {
        if (result.code) {
          return { code: result.code, status: result.status };
        }
      }

      // status=6: activation complete, should already have code
      if (result.status === 'STATUS_CANCEL' || result.status === '6') {
        throw new Error('当前激活已被取消。');
      }

      // status=8: activation cancelled
      if (result.status === '8') {
        throw new Error('当前激活已被取消。');
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('等待短信验证码超时。');
  }

  // 目前是报错 409 的状态 暂时先不使用
  async function completeActivation(apiKey, baseUrl, activationId, status = 3) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const text = await apiGet(normalizedBaseUrl, {
      action: 'setStatus',
      id: activationId,
      status: status,
    }, apiKey);
    return parseSetStatusResponse(text);
  }

  async function cancelActivation(apiKey, baseUrl, activationId) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const text = await apiGet(normalizedBaseUrl, {
      action: 'setStatus',
      id: activationId,
      status: '8',
    }, apiKey);
    return parseSetStatusResponse(text);
  }

  async function getBalance(apiKey, baseUrl) {
    const normalizedBaseUrl = normalizeUrl(baseUrl);
    const text = await apiGet(normalizedBaseUrl, {
      action: 'getBalance',
    }, apiKey);
    return parseBalanceResponse(text);
  }

  function createSmsApiHelpers() {
    return {
      getBalance,
      acquirePhoneNumber,
      getNumberV2,
      getActiveActivations,
      pollForCode,
      pollForCodeV2,
      waitForNewCodeV2,
      completeActivation,
      cancelActivation,
      parseBalanceResponse,
      parseNumberResponse,
      parseStatusResponse,
      parseSetStatusResponse,
      parseErrorResponse,
      parseV2NumberResponse,
      parseV2StatusResponse,
      parseV2ActivationsResponse,
      DEFAULT_BASE_URL,
      DEFAULT_COUNTRY,
      DEFAULT_SERVICE,
    };
  }

  return { createSmsApiHelpers };
});
