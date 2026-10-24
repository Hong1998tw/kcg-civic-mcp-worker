import assert from 'node:assert/strict';
import { checkPhasePid } from './verify-enrichment-v2-capacity.mjs';

const current = { pid: 14, timeOrigin: Date.parse('2026-10-15T09:30:00Z') };
const old = { pid: 14, status: 'complete', finished_at: '2026-10-15T09:20:00Z' };
assert.doesNotThrow(() => checkPhasePid({ phases: { prepare: old } }, 'query', current), 'fresh containers may reuse PID 14');
assert.doesNotThrow(() => checkPhasePid({ phases: { prepare: { ...old, process_time_origin: current.timeOrigin - 1000 } } }, 'query', current));
assert.throws(() => checkPhasePid({ phases: { prepare: { ...old, process_time_origin: current.timeOrigin } } }, 'query', current), /新作業系統程序/);
assert.throws(() => checkPhasePid({ phases: { prepare: { pid: 14, status: 'running', updated_at: old.finished_at } } }, 'query', current), /新作業系統程序/);
assert.throws(() => checkPhasePid({ phases: { query: { ...old, process_time_origin: current.timeOrigin } } }, 'query', current), /新的作業系統程序/);
assert.doesNotThrow(() => checkPhasePid({ phases: { query: { ...old, status: 'failed', updated_at: old.finished_at } } }, 'query', current));
console.log('PASS capacity phase identity: fresh PID namespaces, legacy markers, same-process rejection');
