"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {decodeTrace}=require("../src/deviceTrace");
const {logMetadata}=require("../src/deviceNetwork");
const {during,timeRange}=require("../src/networkController");
const {harRecords}=require("../src/networkEvidence");

function varint(n){const out=[];while(n>=128){out.push(n%128+128);n=Math.floor(n/128);}return Buffer.from([...out,n]);}
function proto(list){return Buffer.concat(list.flatMap(([k,v])=>Buffer.isBuffer(v)?[varint(k*8+2),varint(v.length),v]:[varint(k*8),varint(v)]));}
function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;}
function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;}
function tlv(t,b){return Buffer.concat([u32(t),u32(b.length),b]);}
function segment(name,data){const p=proto([[1,Buffer.from(name)],[3,data]]);return Buffer.concat([u32(p.length),p]);}
function trace(payload,pid) {
    const ev=proto([[1,1700000000],[2,100000000],[5,pid],[9,payload]]);
    const seg=segment("network-profiler",proto([[1,ev]]));
    const head=Buffer.alloc(1024);head.write("OHOSPROF");head.writeBigUInt64LE(BigInt(1024+seg.length),8);
    return Buffer.concat([head,seg]);
}
test("scoped native HTTP trace decodes NetStack timing, method, headers and JSON through the HAR redaction path",()=>{
    const prefix=[0,2000,3000,5000,6000,95000,100000].map(n=>tlv(1,u64(n)));
    const txt=s=>tlv(3,Buffer.from(s));
    const payload=Buffer.concat([...prefix,...["req-1","https://sample.test/items","GET","Authorization: Bearer secret"].map(txt),
        tlv(2,u32(503)),...["Content-Type: application/json","https://sample.test/items","","HTTP/1.1","Failure",'{"token":"private","items":[]}'].map(txt)]);
    const raw=trace(payload,12);
    assert.equal(decodeTrace(raw,15).entries.length,0);
    const {entries,unreadable}=decodeTrace(raw,12);
    const [event]=harRecords({log:{entries}},"device");
    assert.equal(unreadable,0);assert.equal(event.status,503);assert.equal(event.source,"device");
    assert.equal(event.durationMs,100);assert.equal(event.timings.ssl,2);
    assert.equal(event.request.headers.authorization,"[redacted]");assert.equal(event.response.body.token,"[redacted]");
    assert.equal(Date.parse(event.startedAt),1700000000000);
    assert.equal(decodeTrace(trace(Buffer.from("unknown"),12),12).unreadable,1);
    assert.throws(()=>decodeTrace(raw.subarray(0,-1),12));
});
test("timeline matches overlapping requests and only same-time scoped log metadata",()=>{
    const at=1700000000000;
    const logs=logMetadata("1700000000.010 12 13 I A0001/Widget: private text\n1700000000.020 14 15 W A0002/Other: text",12,at,at+100,0);
    assert.deepEqual(logs,[{at:new Date(at+10).toISOString(),level:"I",tag:"A0001/Widget"}]);
    const records=[{id:1,startedAt:new Date(at-100).toISOString(),durationMs:115},{id:2,startedAt:new Date(at+150).toISOString(),durationMs:10}];
    const range=timeRange({at:new Date(at+20).toISOString(),elapsedMs:15});
    assert.deepEqual(during(records,logs,range),{window:range,records:[records[0]],logs});
    assert.deepEqual(during(records,logs,undefined).records,[]);
});
