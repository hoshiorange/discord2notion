/**
 * AIP-37 動作確認: ユーザー別 .opusraw → WAV → 個別 Whisper → speaker 付き transcript.json
 *
 * 既存の recordings/<session>/<userId>.opusraw を使って
 * processSession + transcribeUsersAndSave を直列に流す。
 *
 * 使い方:
 *   npx tsx scripts/test_speaker.ts [session_dir]
 *   （session_dir 省略時は最新セッションを自動選択）
 */

import 'dotenv/config';
import { existsSync, promises as fs, readdirSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';

import { processSession } from '../src/audio.js';
import { aggregateSpeakingTimes, formatSpeakingDuration } from '../src/notion.js';
import { transcribeUsersAndSave } from '../src/transcribe.js';
import type { TranscribeSegment } from '../src/transcribe.js';

function pickLatestSession(): string | null {
  const base = joinPath(process.cwd(), 'recordings');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .map((n) => ({ name: n, full: joinPath(base, n) }))
    .filter((e) => {
      try {
        return statSync(e.full).isDirectory();
      } catch {
        return false;
      }
    });
  // .opusraw を含むセッションのみ対象
  const candidates = dirs.filter((d) => readdirSync(d.full).some((f) => f.endsWith('.opusraw')));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return candidates[0]?.full ?? null;
}

async function main(): Promise<void> {
  const sessionDir = process.argv[2] ?? pickLatestSession();
  if (!sessionDir) {
    console.error('FAILED: .opusraw を持つセッションが見つからない');
    process.exit(1);
    return;
  }
  console.log(`session dir: ${sessionDir}`);

  const entries = await fs.readdir(sessionDir);
  const opusrawFiles = entries
    .filter((e) => e.endsWith('.opusraw'))
    .map((e) => ({ userId: e.replace(/\.opusraw$/, ''), filename: joinPath(sessionDir, e) }));

  console.log(`opusraw files: ${opusrawFiles.length}`);
  for (const f of opusrawFiles) {
    const stat = await fs.stat(f.filename);
    console.log(`  - ${f.userId}: ${stat.size} bytes`);
  }
  if (opusrawFiles.length === 0) {
    console.error('FAILED: .opusraw 0 個');
    process.exit(1);
    return;
  }

  // Step 1: processSession で MP3 + ユーザー別 WAV 生成
  console.log('\n=== Step 1: processSession ===');
  const procResult = await processSession(sessionDir, opusrawFiles);
  console.log({
    mixedMp3: procResult.mixedMp3,
    durationSec: procResult.durationSec,
    inputCount: procResult.inputCount,
    userWavs: procResult.userWavs,
  });
  if (procResult.userWavs.length === 0) {
    console.error('FAILED: userWavs 0 個');
    process.exit(1);
    return;
  }

  // ユーザー表示名は test なので userId そのまま使う（Discord fetch は呼ばない）
  const speakerNames: Record<string, string> = {};
  for (const u of procResult.userWavs) {
    speakerNames[u.userId] = `user_${u.userId.slice(-4)}`; // 末尾4桁を使った疑似表示名
  }

  // Step 2: transcribeUsersAndSave で speaker 付き transcript.json を出力
  console.log('\n=== Step 2: transcribeUsersAndSave ===');
  const tStart = Date.now();
  const { result, transcriptPath, multi } = await transcribeUsersAndSave(
    procResult.userWavs,
    sessionDir,
    speakerNames,
  );
  const elapsed = (Date.now() - tStart) / 1000;
  console.log({
    transcriptPath,
    perUser: multi.perUser.map((p) => ({
      userId: p.userId,
      speaker: p.speaker,
      segments: p.result.segments.length,
      duration: p.result.duration_sec,
    })),
    mergedSegments: result.segments.length,
    durationSec: result.duration_sec,
    elapsedSec: result.elapsed_sec,
    rtFactor: result.realtime_factor,
    elapsedWallSec: elapsed,
  });

  // 検証: 各 segment に speaker が付いているか
  const withSpeaker = result.segments.filter((s) => s.speaker && s.speaker.trim().length > 0).length;
  console.log(`\nsegments with speaker: ${withSpeaker}/${result.segments.length}`);
  if (withSpeaker !== result.segments.length) {
    console.error('FAILED: speaker が付いていない segment が存在する');
    process.exit(1);
    return;
  }

  // 検証: タイムスタンプが昇順か
  let sorted = true;
  for (let i = 1; i < result.segments.length; i++) {
    if (result.segments[i]!.start < result.segments[i - 1]!.start) {
      sorted = false;
      break;
    }
  }
  console.log(`segments sorted by start: ${sorted}`);
  if (!sorted) {
    console.error('FAILED: segments がタイムスタンプ昇順でない');
    process.exit(1);
    return;
  }

  console.log('\n=== First 5 segments ===');
  for (const s of result.segments.slice(0, 5)) {
    console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.speaker}: ${s.text}`);
  }

  // Step 3: 発言時間サマリ（Notion ページ本文の「発言時間」セクション相当）
  console.log('\n=== Step 3: 発言時間サマリ（実 Notion セクション相当） ===');
  const totals = aggregateSpeakingTimes(result.segments);
  console.log('## 発言時間');
  for (const t of totals) {
    console.log(`- **${t.speaker}**: ${formatSpeakingDuration(t.seconds)}`);
  }

  // 単体検証: フォーマッタの境界条件
  console.log('\n=== Step 4: formatSpeakingDuration 境界テスト ===');
  const cases: { input: number; expected: string }[] = [
    { input: 0, expected: '0 秒' },
    { input: 45, expected: '45 秒' },
    { input: 299, expected: '299 秒' }, // 5 分未満
    { input: 300, expected: '5 分 00 秒' }, // 5 分ちょうど
    { input: 750, expected: '12 分 30 秒' },
    { input: 3605, expected: '60 分 05 秒' },
  ];
  let allOk = true;
  for (const c of cases) {
    const actual = formatSpeakingDuration(c.input);
    const ok = actual === c.expected;
    console.log(`  ${ok ? 'OK' : 'NG'} ${c.input}s → "${actual}" (expected "${c.expected}")`);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    console.error('FAILED: formatSpeakingDuration 境界テストで不一致');
    process.exit(1);
    return;
  }

  // 単体検証: aggregateSpeakingTimes が降順 + speaker 不明集約
  console.log('\n=== Step 5: aggregateSpeakingTimes ロジック検証 ===');
  const fixtureSegments: TranscribeSegment[] = [
    { start: 0, end: 10, text: 'a', speaker: '田中' },
    { start: 12, end: 20, text: 'b', speaker: '山田' },
    { start: 25, end: 35, text: 'c', speaker: '田中' },
    { start: 36, end: 40, text: 'd' }, // speaker 未設定 → 「不明」
    { start: 41, end: 44, text: 'e', speaker: '   ' }, // 空白のみ → 「不明」
  ];
  const fxTotals = aggregateSpeakingTimes(fixtureSegments);
  console.log('  fixture totals:', fxTotals);
  const expected: { speaker: string; seconds: number }[] = [
    { speaker: '田中', seconds: 20 },
    { speaker: '山田', seconds: 8 },
    { speaker: '不明', seconds: 7 },
  ];
  const matched =
    fxTotals.length === expected.length &&
    fxTotals.every((t, i) => t.speaker === expected[i]!.speaker && t.seconds === expected[i]!.seconds);
  if (!matched) {
    console.error('FAILED: aggregateSpeakingTimes の出力が期待と異なる');
    console.error('expected:', expected);
    process.exit(1);
    return;
  }
  console.log('  OK: 田中 → 山田 → 不明 の順で集約された');

  // 単体検証: 1 ユーザーセッションでも 1 行だけ出ることを確認
  if (totals.length === 0) {
    console.error('FAILED: totals 0 個（1 ユーザーセッションでも 1 行は出るはず）');
    process.exit(1);
    return;
  }
  console.log(`\nspeakers in actual session: ${totals.length}`);

  console.log('\n✅ AIP-37 E2E OK（発言時間サマリ含む）');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
