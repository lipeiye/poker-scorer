const checks = [
  '确认 public/index.html 的 ?v= 与 public/sw.js 的 CACHE 已同步更新',
  '确认 src/types.ts 的 SERVER_VERSION 已更新',
  '确认后端改动需要完整部署，Durable Object 不支持热更新',
  '确认 npm run check 已通过并记录本次部署 Version ID',
];

console.log('\n生产部署检查：');
for (const check of checks) console.log(`  - ${check}`);
console.log('');
