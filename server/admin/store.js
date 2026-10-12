const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 管理者資格情報の永続化（ADMIN_DATA_DIR/admin.json, 0600, アトミック書き込み）
function createStore(dataDir) {
  const file = path.join(dataDir, 'admin.json');
  let chain = Promise.resolve();

  async function read() {
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  async function write(data) {
    await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dataDir,
      `.admin.json.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.promises.chmod(tmp, 0o600);
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // 読み→変更→書きを直列化する。fn は現在値(null 可)を受け取り、
  // 新しい値を返す。undefined を返した場合は書き込まない。
  function update(fn) {
    const run = chain.then(async () => {
      const cur = await read();
      const next = await fn(cur);
      if (next !== undefined) {
        await write(next);
      }
      return next === undefined ? cur : next;
    });
    chain = run.catch(() => {});
    return run;
  }

  return { file, read, write, update };
}

module.exports = { createStore };
