import 'dotenv/config';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('ERROR: DISCORD_TOKEN が .env にありません');
  process.exit(1);
}

console.log('meetingbot starting...');
console.log(`DISCORD_TOKEN: ${token.slice(0, 10)}...${token.slice(-4)}`);
console.log('TODO: Phase 2 タスク AIP-19 で Discord Client 起動を実装');
