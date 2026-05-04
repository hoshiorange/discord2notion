/**
 * AIP-37 不具合修正の再現テスト: /stop 相当のフローで multi-speaker が走ることを確認する。
 *
 * `commands/stop.ts` と同じ流れ：
 *   processSession → fetchSpeakerNames（モック） → runPostMp3Pipeline（userWavs/speakerNames 付き）
 * Drive / Notion ステージは外部依存があるので、状態確認は transcribe ステージ完了時点でチェックする。
 */

import 'dotenv/config';
import { existsSync, promises as fs, readdirSync, statSync, rmSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';

import { processSession } from '../src/audio.js';
import {
  loadPipelineState,
  PIPELINE_STATE_FILENAME,
  runPostMp3Pipeline,
} from '../src/pipeline.js';

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
  const candidates = dirs.filter((d) => readdirSync(d.full).some((f) => f.endsWith('.opusraw')));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return candidates[0]?.full ?? null;
}

async function copySessionToTempDir(srcDir: string): Promise<string> {
  // 既存セッションを破壊しないためコピー
  const tmpRoot = resolvePath(process.cwd(), 'tmp', 'test_stop_flow');
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });
  const dest = joinPath(tmpRoot, 'session');
  await fs.mkdir(dest, { recursive: true });
  for (const name of await fs.readdir(srcDir)) {
    if (name.endsWith('.opusraw')) {
      await fs.copyFile(joinPath(srcDir, name), joinPath(dest, name));
    }
  }
  return dest;
}

async function main(): Promise<void> {
  const srcSessionDir = process.argv[2] ?? pickLatestSession();
  if (!srcSessionDir) {
    console.error('FAILED: .opusraw を持つセッションが見つからない');
    process.exit(1);
    return;
  }
  console.log(`source session dir: ${srcSessionDir}`);

  const sessionDir = await copySessionToTempDir(srcSessionDir);
  console.log(`temp session dir   : ${sessionDir}`);

  const entries = await fs.readdir(sessionDir);
  const opusrawFiles = entries
    .filter((e) => e.endsWith('.opusraw'))
    .map((e) => ({ userId: e.replace(/\.opusraw$/, ''), filename: joinPath(sessionDir, e) }));
  console.log(`opusraw files: ${opusrawFiles.length}`);

  // Step 1: processSession（stop.ts 互換）
  console.log('\n=== Step 1: processSession ===');
  const procResult = await processSession(sessionDir, opusrawFiles);
  if (!procResult.mixedMp3) {
    console.error('FAILED: mixedMp3 なし');
    process.exit(1);
    return;
  }
  console.log({
    mixedMp3: procResult.mixedMp3,
    userWavs: procResult.userWavs.length,
    inputCount: procResult.inputCount,
  });
  if (procResult.userWavs.length === 0) {
    console.error('FAILED: userWavs 0 個（pipeline へ渡すデータが無い）');
    process.exit(1);
    return;
  }

  // Step 2: fetchSpeakerNames モック（実 Bot は Discord users.fetch 使うが、ここではダミー名）
  const userIds = opusrawFiles.map((f) => f.userId);
  const speakerNames: Record<string, string> = {};
  for (const id of userIds) {
    speakerNames[id] = `テスト_${id.slice(-4)}`;
  }
  console.log('speakerNames:', speakerNames);

  // Step 3: runPostMp3Pipeline（stop.ts と同じ引数を再現）
  console.log('\n=== Step 3: runPostMp3Pipeline (stop.ts 相当) ===');
  // Drive / Notion を実環境で呼びたくないので、transcribe 完了後に state 確認するため
  // env を一時上書きして外部呼び出しを抑止…ではなく、callback で transcribe 完了を捕まえて stop する代わりに
  // savePipelineState 直後に確認するため、まずパイプラインは fail 上等で完走させる（drive/notion 失敗は許容）。
  let transcribeStateSnapshot: unknown = null;
  await runPostMp3Pipeline(
    {
      sessionDir,
      sessionId: 'test_stop_flow',
      startedAt: new Date(),
      durationMs: procResult.durationSec * 1000,
      mixedMp3Path: procResult.mixedMp3,
      channelName: 'test-stop-flow',
      textChannelId: null,
      files: opusrawFiles,
      participants: Object.values(speakerNames),
      userWavs: procResult.userWavs,
      speakerNames,
    },
    {
      onStageComplete: (stage, state) => {
        if (stage === 'transcribe') {
          transcribeStateSnapshot = JSON.parse(JSON.stringify(state));
        }
      },
    },
  );

  // Step 4: pipeline-state.json と transcript.json を検証
  console.log('\n=== Step 4: 結果検証 ===');
  const persistedState = await loadPipelineState(sessionDir);
  if (!persistedState) {
    console.error(`FAILED: ${PIPELINE_STATE_FILENAME} が読めない`);
    process.exit(1);
    return;
  }
  console.log('persisted userWavs:', persistedState.userWavs);
  console.log('persisted speakerNames:', persistedState.speakerNames);

  if (!persistedState.userWavs || persistedState.userWavs.length === 0) {
    console.error('FAILED: pipeline-state.json に userWavs が永続化されていない');
    process.exit(1);
    return;
  }
  if (!persistedState.speakerNames || Object.keys(persistedState.speakerNames).length === 0) {
    console.error('FAILED: pipeline-state.json に speakerNames が永続化されていない');
    process.exit(1);
    return;
  }

  const transcriptPath = joinPath(sessionDir, 'transcript.json');
  const transcriptRaw = await fs.readFile(transcriptPath, 'utf-8');
  const transcript = JSON.parse(transcriptRaw) as {
    audio_path: string;
    segments: { start: number; end: number; text: string; speaker?: string }[];
  };

  // 検証 A: audio_path が mixed.mp3 ではないこと（multi-speaker フローは個別 WAV を渡す）
  const isMixedMp3 = transcript.audio_path.endsWith('mixed.mp3') || transcript.audio_path.endsWith('mixed.mp3"');
  console.log(`transcript.audio_path = ${transcript.audio_path}`);
  if (isMixedMp3) {
    console.error('FAILED: audio_path が mixed.mp3 になっている → multi-speaker フローが走っていない');
    process.exit(1);
    return;
  }

  // 検証 B: 全 segment に speaker が付与されている
  const withSpeaker = transcript.segments.filter((s) => s.speaker && s.speaker.trim().length > 0).length;
  console.log(`segments with speaker: ${withSpeaker}/${transcript.segments.length}`);
  if (withSpeaker !== transcript.segments.length) {
    console.error('FAILED: speaker 未付与 segment が存在 → multi-speaker フローが走っていない');
    process.exit(1);
    return;
  }

  // 検証 C: speakerNames で渡した名前が segment に反映されている
  const expectedNames = new Set(Object.values(speakerNames));
  const actualNames = new Set(transcript.segments.map((s) => s.speaker!));
  const missing = [...expectedNames].filter((n) => !actualNames.has(n));
  if (missing.length > 0) {
    console.error(`FAILED: 期待した speaker 名が segment に出てこない: ${missing.join(', ')}`);
    process.exit(1);
    return;
  }

  console.log('\nfirst 3 segments:');
  for (const s of transcript.segments.slice(0, 3)) {
    console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.speaker}: ${s.text}`);
  }

  console.log('\n✅ /stop 相当フローでの multi-speaker 再現テスト OK');
  if (!transcribeStateSnapshot) {
    console.warn('  (note) transcribe ステージの onStageComplete が呼ばれなかった');
  }

  // tmp は残しておく（必要なら手動削除）。掃除したい場合：
  // rmSync(resolvePath(process.cwd(), 'tmp', 'test_stop_flow'), { recursive: true, force: true });
  console.log(`\nテスト出力は ${sessionDir} に残してあります（必要なら手動削除）`);
  // ESLint unused suppression: rmSync を使う可能性のため import 残す
  void rmSync;
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
