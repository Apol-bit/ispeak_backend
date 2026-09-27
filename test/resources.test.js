const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ispeak-resource-test-'));
process.env.NODE_ENV = 'test';
process.env.LOCAL_STORAGE_ROOT = temp;
process.env.JWT_SECRET = 'resource-tests-only-secret-not-a-real-credential';
const User = require('../models/User');
const Resource = require('../models/LearningResource');
const records = new Map();
User.findById = id => ({select: async () => ({_id: id, role: id === 'admin' ? 'admin' : 'user',
  status: 'Active', isArchived: false, level: id})});
Resource.prototype.save = async function () { await this.validate(); records.set(String(this._id), this); return this; };
Resource.find = filter => ({sort: async () => [...records.values()].filter(row =>
  (!filter.type || row.type === filter.type) &&
  (!filter.difficulty || row.difficulty === filter.difficulty))});
Resource.findById = async id => records.get(id);
Resource.findByIdAndUpdate = async (id, data) => {
  const resource = records.get(id); if (!resource) return null;
  resource.set(data); await resource.validate(); return resource;
};
Resource.findByIdAndDelete = async id => {const resource = records.get(id); records.delete(id); return resource;};
Resource.bulkWrite = async operations => {
  for (const operation of operations) {
    const resource = records.get(String(operation.updateOne.filter._id));
    if (resource) resource.set(operation.updateOne.update.$set);
  }
};
const {app} = require('../server');
let server, url;
const token = role => jwt.sign({userId: role}, process.env.JWT_SECRET,
  {algorithm: 'HS256', issuer: 'ispeak-api', audience: 'ispeak-clients', expiresIn: '1h'});
async function request(route, role = 'admin', method = 'GET', values) {
  let body;
  const headers = {Authorization: 'Bearer ' + token(role)};
  if (values && method === 'PATCH') {
    body = JSON.stringify(values); headers['Content-Type'] = 'application/json';
  } else if (values) {
    body = new FormData(); for (const [key, value] of Object.entries(values)) body.append(key, value);
  }
  const response = await fetch(url + route, {method, headers, body});
  return {status: response.status, body: await response.json()};
}
test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, {recursive: true, force: true});
});
test('resource create/update/read/delete preserve camelCase iconName and legacy difficulty', async () => {
  records.clear();
  // createdBy is an ObjectId in the real schema; use the existing authenticated identity shape.
  const original = User.findById;
  User.findById = id => ({select: async () => ({_id:'507f1f77bcf86cd799439011', role:'admin', status:'Active', isArchived:false})});
  try {
    const created = await request('/admin/resources', 'admin', 'POST', {
      type:'GuidedTask', title:'Voice exercise', description:'Practice', difficulty:'Advanced',
      language:'English', iconName:'flash_on', steps:JSON.stringify(['Breathe.']),
    });
    assert.equal(created.status,201); const id = created.body.resource._id;
    assert.equal(created.body.resource.iconName,'flash_on');
    const updated = await request('/admin/resources/'+id,'admin','PUT',{title:'Updated exercise',iconName:'volume_up'});
    assert.equal(updated.status,200); assert.equal(updated.body.resource.iconName,'volume_up');
    assert.equal(updated.body.resource.difficulty,'Advanced');
    const listed=await request('/resources'); assert.equal(listed.body.find(r=>r._id===id).iconName,'volume_up');
    assert.equal((await request('/admin/resources/'+id,'admin','DELETE')).status,200);
    assert.equal((await request('/resources')).body.some(r=>r._id===id),false);
  } finally {User.findById=original;}
});
test('new resources append and moving groups assigns the target end order', async () => {
  records.clear();
  const original = User.findById;
  User.findById = id => ({select: async () => ({_id:'507f1f77bcf86cd799439011', role:'admin', status:'Active', isArchived:false})});
  try {
    const target = new Resource({type:'Script',difficulty:'Intermediate',title:'Target existing',description:'Fixture',displayOrder:1});
    records.set(String(target._id),target);
    const first = await request('/admin/resources', 'admin', 'POST', {
      type:'Script', difficulty:'Beginner', title:'First', description:'Fixture'
    });
    const second = await request('/admin/resources', 'admin', 'POST', {
      type:'Script', difficulty:'Beginner', title:'Second', description:'Fixture'
    });
    assert.equal(first.body.resource.displayOrder, 1);
    assert.equal(second.body.resource.displayOrder, 2);
    const moved = await request('/admin/resources/'+first.body.resource._id, 'admin', 'PUT', {
      type:'Script', difficulty:'Intermediate', title:'First', description:'Fixture'
    });
    assert.equal(moved.body.resource.displayOrder, 2);
    assert.equal(moved.body.resource.difficulty, 'Intermediate');
  } finally { User.findById = original; }
});
test('legacy records remain readable and a new resource appends after them', async () => {
  records.clear();
  const legacy = new Resource({type:'Challenge',difficulty:'Beginner',title:'Legacy',description:'Fixture'});
  records.set(String(legacy._id),legacy);
  const original = User.findById;
  User.findById = id => ({select: async () => ({_id:'507f1f77bcf86cd799439011', role:'admin', status:'Active', isArchived:false})});
  try {
    const created = await request('/admin/resources', 'admin', 'POST', {
      type:'Challenge',difficulty:'Beginner',title:'New',description:'Fixture'
    });
    assert.equal(created.body.resource.displayOrder,2);
    const listed = await request('/resources?type=Challenge');
    assert.deepEqual(listed.body.map(row=>row.title),['Legacy','New']);
  } finally { User.findById = original; }
});
test('reorder validates one complete group and modifies only displayOrder', async () => {
  records.clear();
  const first = new Resource({type:'Script',difficulty:'Beginner',title:'First',description:'Fixture',displayOrder:1});
  const second = new Resource({type:'Script',difficulty:'Beginner',title:'Second',description:'Fixture',displayOrder:2});
  const other = new Resource({type:'Challenge',difficulty:'Beginner',title:'Other',description:'Fixture',displayOrder:1});
  for (const row of [first,second,other]) records.set(String(row._id),row);
  const result = await request('/admin/resources/reorder','admin','PATCH',{
    type:'Script',difficulty:'Beginner',orderedIds:[String(second._id),String(first._id)]
  });
  assert.equal(result.status,200);
  assert.deepEqual(result.body.resources.map(row=>row.title),['Second','First']);
  assert.deepEqual(result.body.resources.map(row=>row.displayOrder),[1,2]);
  assert.equal(records.get(String(first._id)).title,'First');
  assert.equal(records.get(String(other._id)).displayOrder,1);
  const crossType = await request('/admin/resources/reorder','admin','PATCH',{
    type:'Script',difficulty:'Beginner',orderedIds:[String(first._id),String(other._id)]
  });
  assert.equal(crossType.status,400);
  const incomplete = await request('/admin/resources/reorder','admin','PATCH',{
    type:'Script',difficulty:'Beginner',orderedIds:[String(first._id)]
  });
  assert.equal(incomplete.status,400);
});
for (const type of ['Challenge','GuidedTask']) {
  test(`${type} order persists independently`, async () => {
    records.clear();
    const difficulty = type === 'GuidedTask' ? 'None' : 'Advanced';
    const first = new Resource({type,difficulty,title:'First',description:'Fixture',displayOrder:1});
    const second = new Resource({type,difficulty,title:'Second',description:'Fixture',displayOrder:2});
    records.set(String(first._id),first); records.set(String(second._id),second);
    const result = await request('/admin/resources/reorder','admin','PATCH',{
      type,
      ...(type === 'GuidedTask' ? {} : {difficulty}),
      orderedIds:[String(second._id),String(first._id)]
    });
    assert.equal(result.status,200);
    assert.deepEqual(result.body.resources.map(row=>row.title),['Second','First']);
  });
}
for (const userLevel of ['Beginner','Intermediate','Advanced']) {
  test(`${userLevel} gets all Guided Tasks; Script/Challenge API difficulty metadata remains unchanged`, async () => {
    records.clear();
    for (const type of ['GuidedTask','Script','Challenge']) {
      for (const difficulty of ['Beginner','Intermediate','Advanced','None']) {
        const resource = new Resource({type,difficulty,title:`${type} ${difficulty}`,description:'Fixture',
          iconName:difficulty==='Advanced'?'flash_on':'volume_up',referenceAudioPath:'private-reference.wav'});
        records.set(String(resource._id),resource);
      }
    }
    const all=await request('/resources?level='+userLevel,userLevel);
    assert.equal(all.status,200); assert.equal(all.body.length,12);
    assert.ok(all.body.every(row=>row.referenceAudioPath===undefined));
    for (const type of ['GuidedTask','Script','Challenge']) {
      const rows=(await request('/resources?type='+type+'&level='+userLevel,userLevel)).body;
      assert.deepEqual(rows.map(row=>row.difficulty),['Beginner','Intermediate','Advanced','None']);
      assert.equal(rows[2].iconName,'flash_on');
    }
    // Existing API returns metadata; Script/Challenge proficiency gating remains in Flutter.
  });
}
test('normal users cannot mutate resources', async () => {
  assert.equal((await request('/admin/resources','Beginner','POST',{type:'GuidedTask'})).status,403);
  assert.equal((await request('/admin/resources/unknown','Beginner','PUT',{iconName:'timer'})).status,403);
  assert.equal((await request('/admin/resources/unknown','Beginner','DELETE')).status,403);
  assert.equal((await request('/admin/resources/reorder','Beginner','PATCH',{
    type:'GuidedTask',orderedIds:['507f1f77bcf86cd799439011']
  })).status,403);
});
