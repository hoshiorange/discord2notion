/**
 * AIP-32 Voice 再接続戦略の擬似テスト。
 *
 * Mock VoiceConnection を使って、Discord に接続せずに以下の3ケースを検証する：
 *   1. Phase 1（自動回復）成功 → reconnect_failed 発火しない
 *   2. Phase 1 失敗 → Phase 2（手動 rejoin）1 回目で成功 → reconnect_failed 発火しない
 *   3. Phase 1 / Phase 2 全失敗 → reconnect_failed 発火（rejoin 試行 3 回）
 *
 * 実行: `npx tsx scripts/test_voice_reconnect.ts`
 * 所要時間: 約 70 秒（ケース3 でタイムアウトを実時間で待つため）
 */

import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { voiceManager } from '../src/voice.js';

// テスト時のバックオフを短縮（10ms × 1, 2, 3）
process.env.VOICE_RECONNECT_BACKOFF_MS = '10';
process.env.VOICE_RECONNECT_MAX_ATTEMPTS = '3';

// VoiceManager のプライベート method `handleDisconnect` を呼ぶための型キャスト
type HandleDisconnectFn = (conn: VoiceConnection) => Promise<void>;
const handleDisconnect = (
  voiceManager as unknown as { handleDisconnect: HandleDisconnectFn }
).handleDisconnect.bind(voiceManager);

class MockVoiceConnection extends EventEmitter {
  state: { status: VoiceConnectionStatus } = {
    status: VoiceConnectionStatus.Disconnected,
  };
  rejoinCount = 0;
  rejoinHandler?: (mock: this) => void;

  setStatus(status: VoiceConnectionStatus): void {
    const oldState = this.state;
    this.state = { status };
    this.emit('stateChange', oldState, this.state);
    this.emit(status, oldState, this.state);
  }

  rejoin(): boolean {
    this.rejoinCount++;
    queueMicrotask(() => this.rejoinHandler?.(this));
    return true;
  }

  destroy(): void {
    // no-op
  }
}

function asConnection(mock: MockVoiceConnection): VoiceConnection {
  return mock as unknown as VoiceConnection;
}

let failures = 0;

async function runCase1(): Promise<void> {
  console.log('\n=== ケース1: Phase 1 自動回復成功 ===');
  const start = Date.now();
  const mock = new MockVoiceConnection();
  let reconnectFailedFired = false;
  const onFail = (): void => {
    reconnectFailedFired = true;
  };
  voiceManager.on('reconnect_failed', onFail);

  // 50ms 後に Signalling、100ms 後に Ready に遷移させる
  setTimeout(() => mock.setStatus(VoiceConnectionStatus.Signalling), 50);
  setTimeout(() => mock.setStatus(VoiceConnectionStatus.Ready), 100);

  await handleDisconnect(asConnection(mock));
  voiceManager.off('reconnect_failed', onFail);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (reconnectFailedFired) {
    console.error(`  ❌ reconnect_failed が誤発火 (${elapsed}s)`);
    failures++;
    return;
  }
  if (mock.rejoinCount !== 0) {
    console.error(`  ❌ rejoin が呼ばれてしまった: ${mock.rejoinCount}回 (${elapsed}s)`);
    failures++;
    return;
  }
  console.log(`  ✅ 自動回復成功、reconnect_failed 発火なし、rejoin 呼び出しなし (${elapsed}s)`);
}

async function runCase2(): Promise<void> {
  console.log('\n=== ケース2: Phase 2 で rejoin 1 回目で成功 ===');
  console.log('  ⏱ Phase 1 のタイムアウト 5 秒待ち...');
  const start = Date.now();
  const mock = new MockVoiceConnection();
  let reconnectFailedFired = false;
  const onFail = (): void => {
    reconnectFailedFired = true;
  };
  voiceManager.on('reconnect_failed', onFail);

  // Phase 1: 何もしない → 5 秒タイムアウト
  // Phase 2: rejoin 呼ばれたら直後に Ready
  mock.rejoinHandler = (m) => {
    m.setStatus(VoiceConnectionStatus.Ready);
  };

  await handleDisconnect(asConnection(mock));
  voiceManager.off('reconnect_failed', onFail);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (reconnectFailedFired) {
    console.error(`  ❌ reconnect_failed が誤発火 (${elapsed}s)`);
    failures++;
    return;
  }
  if (mock.rejoinCount !== 1) {
    console.error(
      `  ❌ rejoin 呼び出し回数が想定外: ${mock.rejoinCount}回 (期待値: 1) (${elapsed}s)`,
    );
    failures++;
    return;
  }
  console.log(`  ✅ rejoin ${mock.rejoinCount} 回で成功、reconnect_failed 発火なし (${elapsed}s)`);
}

async function runCase3(): Promise<void> {
  console.log('\n=== ケース3: 全失敗 → reconnect_failed 発火 ===');
  console.log('  ⏱ Phase 1 5 秒 + Phase 2 各 20 秒 × 3 回 = 約 65 秒待ち...');
  const start = Date.now();
  const mock = new MockVoiceConnection();
  let reconnectFailedFired = false;
  const onFail = (): void => {
    reconnectFailedFired = true;
  };
  voiceManager.on('reconnect_failed', onFail);

  // 何もしない → Phase 1 タイムアウト & 各 rejoin 後の Ready タイムアウト
  await handleDisconnect(asConnection(mock));
  voiceManager.off('reconnect_failed', onFail);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  if (!reconnectFailedFired) {
    console.error(`  ❌ reconnect_failed が発火しない (${elapsed}s)`);
    failures++;
    return;
  }
  if (mock.rejoinCount !== 3) {
    console.error(
      `  ❌ rejoin 呼び出し回数が想定外: ${mock.rejoinCount}回 (期待値: 3) (${elapsed}s)`,
    );
    failures++;
    return;
  }
  console.log(
    `  ✅ rejoin ${mock.rejoinCount} 回試行 → reconnect_failed 発火 (${elapsed}s)`,
  );
}

await runCase1();
await runCase2();
await runCase3();

if (failures > 0) {
  console.error(`\n❌ ${failures} 件失敗\n`);
  process.exit(1);
}
console.log('\n🎉 全ケース pass\n');
