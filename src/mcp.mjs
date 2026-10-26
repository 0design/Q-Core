import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { CoreError } from './contracts.mjs';
import { guardedStreamWrite } from './persistence.mjs';
import { requestApproval } from './mcp-approval.mjs';

const PROTOCOLS = new Set(['2025-11-25', '2025-06-18']);
const TOOL = {
  name: 'request_approval',
  description: 'Ask the human to approve or reject the exact delivery of a waiting gate through the client form.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string', minLength: 1 }, gate_id: { type: 'string', minLength: 1 } },
    required: ['run_id', 'gate_id'],
    additionalProperties: false,
  },
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const validId = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Each stdio connection owns its capabilities and unguessable response IDs. */
export function createMcpSession({ manifestFile, send }) {
  if (typeof manifestFile !== 'string' || !manifestFile.trim()) throw new CoreError('INVALID_REQUEST', 'A manifest file is required at server startup');
  if (typeof send !== 'function') throw new TypeError('send must be a function');
  const pinnedManifest = resolve(manifestFile);
  const pending = new Map();
  const calls = new Map();
  let phase = 'new', capabilities, protocolVersion, closed = false;

  const emit = message => { if (!closed) send(message); };
  function cancel(call, reason) {
    call.cancelled = true;
    for (const id of call.pending) {
      const response = pending.get(id);
      pending.delete(id);
      response?.reject(new CoreError('MCP_ELICITATION_CANCELLED', reason));
    }
    call.pending.clear();
  }
  function close(reason = 'The MCP client disconnected; no approval was recorded') {
    if (closed) return;
    closed = true;
    for (const call of calls.values()) cancel(call, reason);
    pending.clear();
  }
  function elicit(params, call) {
    if (closed || call.cancelled) return Promise.reject(new CoreError('MCP_ELICITATION_CANCELLED', 'The approval request was cancelled'));
    const support = capabilities?.elicitation;
    if (!object(support) || (Object.keys(support).length && !object(support.form))) {
      return Promise.reject(new CoreError('MCP_ELICITATION_UNSUPPORTED', 'This MCP client does not support form elicitation; approval cannot be supplied by the model'));
    }
    const id = randomUUID();
    const request = { ...params };
    if (protocolVersion === '2025-06-18') delete request.mode;
    else request.mode = 'form';
    return new Promise((resolveResponse, reject) => {
      pending.set(id, { resolve: resolveResponse, reject, call });
      call.pending.add(id);
      try { emit({ jsonrpc: '2.0', id, method: 'elicitation/create', params: request }); }
      catch (error) {
        pending.delete(id);
        call.pending.delete(id);
        reject(error);
      }
    }).then(result => {
      if (closed || call.cancelled) throw new CoreError('MCP_ELICITATION_CANCELLED', 'The approval request was cancelled');
      return result;
    });
  }

  async function request(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
      if (phase !== 'new') return emit(rpcError(id, -32600, 'This MCP session is already initialized'));
      if (!object(params) || typeof params.protocolVersion !== 'string' || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        return emit(rpcError(id, -32602, 'initialize requires protocolVersion, capabilities, and clientInfo'));
      }
      protocolVersion = PROTOCOLS.has(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
      capabilities = structuredClone(params.capabilities);
      phase = 'initializing';
      return emit({ jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'q-core', version: '0.2.0' } } });
    }
    if (phase !== 'ready') return emit(rpcError(id, -32000, 'Complete MCP initialization before sending requests'));
    if (calls.has(id)) return emit(rpcError(id, -32600, 'A request with this ID is already in progress'));
    if (method === 'ping') return emit({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      if (params !== undefined && (!only(params, ['_meta']) || (params._meta !== undefined && !object(params._meta)))) return emit(rpcError(id, -32602, 'tools/list accepts only request metadata'));
      return emit({ jsonrpc: '2.0', id, result: { tools: [structuredClone(TOOL)] } });
    }
    if (method !== 'tools/call') return emit(rpcError(id, -32601, 'Unknown MCP method'));
    if (!only(params, ['name', 'arguments', '_meta']) || (params._meta !== undefined && !object(params._meta)) || params.name !== TOOL.name ||
        !only(params.arguments, ['run_id', 'gate_id']) ||
        !['run_id', 'gate_id'].every(key => typeof params.arguments[key] === 'string' && params.arguments[key].trim())) {
      return emit(rpcError(id, -32602, 'request_approval accepts only run_id and gate_id; decisions must come directly from client elicitation'));
    }
    const call = { cancelled: false, pending: new Set() };
    calls.set(id, call);
    try {
      const result = await requestApproval(params.arguments, {
        manifestFile: pinnedManifest,
        capabilities,
        elicit: form => elicit(form, call),
        assertActive: () => {
          if (closed || call.cancelled) throw new CoreError('MCP_ELICITATION_CANCELLED', 'The approval request was cancelled; no approval was recorded');
        },
      });
      if (!call.cancelled) emit({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (error) {
      emit({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `${error.code ?? 'MCP_APPROVAL_FAILED'}: ${error.message}` }] } });
    } finally {
      calls.delete(id);
      cancel(call, 'The approval request has finished');
    }
  }

  function receive(message) {
    if (closed) return Promise.resolve();
    if (!object(message) || message.jsonrpc !== '2.0') {
      emit(rpcError(null, -32600, 'Invalid JSON-RPC message'));
      return Promise.resolve();
    }
    // Requests never resolve server requests, even if their IDs collide.
    if (!own(message, 'method')) {
      const hasResult = own(message, 'result'), hasError = own(message, 'error');
      if (phase !== 'ready' || !validId(message.id) || hasResult === hasError ||
          !only(message, ['jsonrpc', 'id', hasResult ? 'result' : 'error'])) return Promise.resolve();
      const response = pending.get(message.id);
      if (!response) return Promise.resolve();
      pending.delete(message.id);
      response.call.pending.delete(message.id);
      if (hasError) response.reject(new CoreError('MCP_ELICITATION_FAILED', 'The client could not complete the elicitation request'));
      else response.resolve(message.result);
      return Promise.resolve();
    }
    if (typeof message.method !== 'string' || !only(message, ['jsonrpc', 'id', 'method', 'params']) || (own(message, 'id') && !validId(message.id))) {
      emit(rpcError(validId(message.id) ? message.id : null, -32600, 'Invalid JSON-RPC request'));
      return Promise.resolve();
    }
    if (!own(message, 'id')) {
      if (message.method === 'notifications/initialized' && phase === 'initializing' &&
          (message.params === undefined || only(message.params, []))) phase = 'ready';
      if (message.method === 'notifications/cancelled' && phase === 'ready' &&
          only(message.params, ['requestId', 'reason']) && validId(message.params.requestId)) {
        const call = calls.get(message.params.requestId) ?? pending.get(message.params.requestId)?.call;
        if (call) cancel(call, 'The client cancelled the approval request; no approval was recorded');
      }
      return Promise.resolve();
    }
    return request(message);
  }
  return { receive, close };
}

/** Serve newline-delimited JSON-RPC while tool calls await client responses. */
export async function serveMcp({ manifestFile, input = process.stdin, output = process.stdout }) {
  const session = createMcpSession({ manifestFile, send: message => guardedStreamWrite(output, JSON.stringify(message) + '\n') });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const active = new Set();
  let transportError;
  const disconnected = () => { session.close(); lines.close(); };
  const failed = error => {
    transportError ??= error;
    session.close('MCP transport failed; no approval was recorded');
    lines.close();
  };
  input.on('end', disconnected);
  input.on('close', disconnected);
  output.on('close', disconnected);
  output.on('error', failed);
  try {
    for await (const line of lines) {
      let message;
      try { message = JSON.parse(line); }
      catch {
        guardedStreamWrite(output, JSON.stringify(rpcError(null, -32700, 'Invalid JSON')) + '\n');
        continue;
      }
      const task = session.receive(message);
      active.add(task);
      task.catch(failed).finally(() => active.delete(task));
    }
  } finally {
    session.close();
    lines.close();
    input.off('end', disconnected);
    input.off('close', disconnected);
    output.off('close', disconnected);
    output.off('error', failed);
    await Promise.allSettled(active);
  }
  if (transportError) throw transportError;
}
