/**
 * AIP-38: `resolveGuildFolderName` の純関数ユニットテスト。
 *
 * 実 Google Drive API は **一切叩かない**。drive.ts から純関数だけを import して
 * 入出力検証する。サニタイズ判定（許可/フォールバック）の境界ケースを網羅する。
 *
 * 実行: `npx tsx scripts/test_guild_folder_name.ts`
 */

import { resolveGuildFolderName } from '../src/drive.js';

interface CaseReport {
  name: string;
  pass: boolean;
  detail: string;
}

const reports: CaseReport[] = [];

function check(name: string, condition: boolean, detail: string): void {
  reports.push({ name, pass: condition, detail });
  const tag = condition ? '  PASS' : '  FAIL';
  // eslint-disable-next-line no-console
  console.log(`${tag} ${name} :: ${detail}`);
}

function expectEq(actual: string, expected: string): boolean {
  return actual === expected;
}

function main(): void {
  // ====== 安全文字（許可）======
  {
    const got = resolveGuildFolderName('仕事', '1234567890');
    check('日本語の name → "<name>-<guildId>"', expectEq(got, '仕事-1234567890'), got);
  }
  {
    const got = resolveGuildFolderName('Work Team', '999');
    check('英数字とスペースの name', expectEq(got, 'Work Team-999'), got);
  }
  {
    const got = resolveGuildFolderName('my_proj-2025', 'AAA');
    check('ハイフン・アンダースコア・数字混在', expectEq(got, 'my_proj-2025-AAA'), got);
  }
  {
    const got = resolveGuildFolderName('カタカナひらがな漢字', '111');
    check('ひらがな・カタカナ・漢字（\\p{L}）', expectEq(got, 'カタカナひらがな漢字-111'), got);
  }

  // ====== name 未指定 / 空 / 空白のみ → guildId のみ ======
  {
    const got = resolveGuildFolderName(undefined, '1234');
    check('name 未指定 → guildId のみ', expectEq(got, '1234'), got);
  }
  {
    const got = resolveGuildFolderName('', '5678');
    check('name 空文字 → guildId のみ', expectEq(got, '5678'), got);
  }
  {
    const got = resolveGuildFolderName('   ', '777');
    check('name 空白のみ（trim 後空）→ guildId のみ', expectEq(got, '777'), got);
  }

  // ====== NG 文字（フォールバック + warn ログ） ======
  {
    const got = resolveGuildFolderName('a/b', '111');
    check('スラッシュ含み → guildId のみ', expectEq(got, '111'), got);
  }
  {
    const got = resolveGuildFolderName('back\\slash', '222');
    check('バックスラッシュ含み → guildId のみ', expectEq(got, '222'), got);
  }
  {
    const got = resolveGuildFolderName('hello:world', '333');
    check('Windows 予約 ":" 含み → guildId のみ', expectEq(got, '333'), got);
  }
  {
    const got = resolveGuildFolderName('a*b?c"d<e>f|g', '444');
    check('Windows 予約文字一式 → guildId のみ', expectEq(got, '444'), got);
  }
  {
    const got = resolveGuildFolderName('multi\nline', '555');
    check('改行含み → guildId のみ', expectEq(got, '555'), got);
  }
  {
    const got = resolveGuildFolderName('tab\there', '666');
    check('タブ含み → guildId のみ（制御文字扱い）', expectEq(got, '666'), got);
  }
  {
    const got = resolveGuildFolderName('cr\rhere', '6666');
    check('キャリッジリターン含み → guildId のみ', expectEq(got, '6666'), got);
  }
  {
    const got = resolveGuildFolderName('emoji😀here', '777');
    check('絵文字含み → guildId のみ', expectEq(got, '777'), got);
  }
  {
    // 全角スペースは許可
    const got = resolveGuildFolderName('チーム　A', '7777');
    check('全角スペース含み → 許可', expectEq(got, 'チーム　A-7777'), got);
  }

  // ====== guildId 側のフォールバック ======
  {
    const got = resolveGuildFolderName('仕事', null);
    check('guildId=null + 安全 name → "<name>-default"', expectEq(got, '仕事-default'), got);
  }
  {
    const got = resolveGuildFolderName('仕事', '');
    check('guildId 空文字 + 安全 name → "<name>-default"', expectEq(got, '仕事-default'), got);
  }
  {
    const got = resolveGuildFolderName(undefined, undefined);
    check('name 未指定 + guildId 未指定 → "default"', expectEq(got, 'default'), got);
  }
  {
    const got = resolveGuildFolderName('a/b', null);
    check('NG name + guildId=null → "default"', expectEq(got, 'default'), got);
  }

  // ====== 周辺ホワイトスペース（trim される） ======
  {
    const got = resolveGuildFolderName('  仕事  ', '888');
    check('name 前後空白 → trim されて使われる', expectEq(got, '仕事-888'), got);
  }

  // ====== summary ======
  const passed = reports.filter((r) => r.pass).length;
  const failed = reports.length - passed;
  // eslint-disable-next-line no-console
  console.log(`\n=== summary: ${passed} passed / ${failed} failed (total ${reports.length}) ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
