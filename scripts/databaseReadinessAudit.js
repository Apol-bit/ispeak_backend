// Read-only audit: no models, index creation, writes, user identifiers or URI output.
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });

async function duplicateSummary(collection, fields, normalize = false) {
  const key = Object.fromEntries(fields.map(field => [field, normalize
    ? { $toLower: { $trim: { input: { $convert: { input: `$${field}`, to: 'string', onError: '', onNull: '' } } } } }
    : `$${field}`]));
  const rows = await collection.aggregate([
    { $group: { _id: key, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, documents: { $sum: '$count' } } },
    { $project: { _id: 0, groups: 1, documents: 1 } },
  ], { maxTimeMS: 10000 }).toArray();
  return rows[0] || { groups: 0, documents: 0 };
}

async function main() {
  const uri = process.env.MONGO_URI;
  const report = { readOnly: true, configured: Boolean(uri), srv: Boolean(uri?.startsWith('mongodb+srv://')) };
  if (!uri) { console.log(JSON.stringify({ ...report, status: 'NOT VERIFIED — configuration unavailable' })); process.exitCode = 2; return; }
  const connection = mongoose.createConnection(uri, {
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 3000,
    maxPoolSize: 2, minPoolSize: 0,
  });
  try {
    await connection.asPromise();
    await connection.db.command({ ping: 1 });
    report.status = 'CONNECTED — read-only inspection';
    report.explicitDatabaseName = Boolean(new URL(uri).pathname.replace(/^\//, ''));
    report.collections = {};
    const existing = new Set((await connection.db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
    for (const name of ['users', 'speechsessions', 'learningresources', 'storagecleanups']) {
      if (!existing.has(name)) { report.collections[name] = { exists: false }; continue; }
      const collection = connection.db.collection(name);
      report.collections[name] = {
        exists: true, documents: await collection.countDocuments({}, { maxTimeMS: 10000 }),
        indexes: (await collection.listIndexes().toArray()).map(({ key, unique, expireAfterSeconds }) =>
          ({ key, unique: Boolean(unique || (key._id === 1 && Object.keys(key).length === 1)), ...(expireAfterSeconds === undefined ? {} : { expireAfterSeconds }) })),
      };
    }
    if (existing.has('users')) {
      report.userDuplicates = {};
      for (const field of ['email', 'username']) {
        report.userDuplicates[field] = {
          exact: await duplicateSummary(connection.db.collection('users'), [field]),
          normalized: await duplicateSummary(connection.db.collection('users'), [field], true),
          missingNullOrEmpty: await connection.db.collection('users').countDocuments({
            $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }],
          }),
        };
      }
    }
    if (existing.has('storagecleanups')) {
      report.cleanupDuplicates = await duplicateSummary(connection.db.collection('storagecleanups'), ['namespace', 'key']);
    }
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.log(JSON.stringify({ ...report, status: 'NOT VERIFIED — database inspection unavailable' }, null, 2));
    process.exitCode = 2;
  } finally { await connection.close().catch(() => {}); }
}

if (require.main === module) main().catch(() => { console.error('Read-only database audit failed; no data changed.'); process.exitCode = 1; });
module.exports = { duplicateSummary };
