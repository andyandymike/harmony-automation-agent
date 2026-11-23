"use strict";
const fs=require("node:fs/promises");
const {createHash}=require("node:crypto");
const {harRecords}=require("./networkEvidence");
const emptyTraceDigest=createHash("sha256").digest();

// OpenHarmony hiprofiler TraceFileHeader / ProfilerPluginData and
// communication_netstack DfxMessage (utils/tlv_utils/src/tlv_utils.cpp).
function protobuf(buffer) {
    const fields = new Map();
    let offset = 0;
    function varint() {
        let value = 0, factor = 1;
        for (let i = 0; i < 10 && offset < buffer.length; i++) {
            const byte = buffer[offset++];
            value += (byte & 127) * factor;
            if (byte < 128) return value;
            factor *= 128;
        }
        throw new Error("Incomplete profiler protobuf.");
    }
    while (offset < buffer.length) {
        const key = varint(), field = Math.floor(key / 8), wire = key % 8;
        let value;
        if (wire === 0) value = varint();
        else {
            const size = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
            if (size < 0 || size > buffer.length - offset) throw new Error("Unsupported profiler field.");
            value = buffer.subarray(offset, offset + size);
            offset += size;
        }
        if (!fields.has(field)) fields.set(field, []);
        fields.get(field).push(value);
    }
    return fields;
}

function headers(raw) {
    return raw.split(/\r?\n/).filter(s => s.indexOf(":") > 0).map(line => {
        const i = line.indexOf(":");
        return { name:line.slice(0,i).trim(), value:line.slice(i+1).trim() };
    });
}

function httpEntry(payload, endTime) {
    // The public encoder writes seven boot-clock microsecond timestamps in order.
    const types = [1,1,1,1,1,1,1,3,3,3,3,2,3,3,3,3,3,3];
    let offset = 0;
    const values = [];
    for (const type of types) {
        if (offset + 8 > payload.length || payload.readUInt32LE(offset) !== type) return;
        const length = payload.readUInt32LE(offset + 4);
        offset += 8;
        if (offset + length > payload.length || (type === 1 && length !== 8) || (type === 2 && length !== 4)) return;
        values.push(type === 1 ? Number(payload.readBigUInt64LE(offset)) : type === 2 ? payload.readUInt32LE(offset) :
            payload.toString("utf8",offset,offset+length));
        offset += length;
    }
    const [start,dns,tcp,tls,sent,first,end,,url,method,requestHeaders,status,responseHeaders,,,,,body] = values;
    if (!/^https?:\/\//i.test(url) || !/^[A-Z]+$/i.test(method) || !Number.isFinite(endTime) || endTime <= 0 || end < start) return;
    const time = (end-start)/1000;
    const response = headers(responseHeaders);
    return {startedDateTime:new Date(endTime-time).toISOString(),time,request:{method,url,headers:headers(requestHeaders)},
        response:{status,headers:response,content:{mimeType:response.find(h => h.name.toLowerCase()==="content-type")?.value,text:body}},
        timings:{dns:(dns-start)/1000,connect:(tls-dns)/1000,ssl:(tls-tcp)/1000,send:(sent-tls)/1000,
            wait:(first-sent)/1000,receive:(end-first)/1000}};
}

function checkHeader(buffer,size) {
    if (buffer.length < 1024 || buffer.toString("ascii",0,8) !== "OHOSPROF" ||
        buffer.readBigUInt64LE(8) !== BigInt(size)) throw new Error("Incomplete or unrecognized HarmonyOS trace. / 采集文件不完整或格式未知。");
}
function decodeSegment(segment,pid,clockOffsetMs,add) {
    const block=protobuf(segment);
    if(block.get(1)?.[0]?.toString()!=="network-profiler")return 0;
    const data=block.get(3)?.[0];
    if(!Buffer.isBuffer(data))return 0;
    let unreadable=0;
    for(const event of protobuf(data).get(1) || []){
        const fields=protobuf(event);
        if(fields.get(5)?.[0]!==pid)continue;
        const payload=fields.get(9)?.[0];
        const time=Number(fields.get(1)?.[0])*1000+Number(fields.get(2)?.[0]||0)/1e6+clockOffsetMs;
        const entry=Buffer.isBuffer(payload) && httpEntry(payload,time);
        if(entry)add(entry);
        else unreadable++;
    }
    return unreadable;
}
function decodeTrace(buffer,pid,clockOffsetMs=0) {
    checkHeader(buffer,buffer.length);
    let offset=1024,unreadable=0;
    const entries=[];
    while(offset<buffer.length){
        if(offset+4>buffer.length)throw new Error("Incomplete trace segment.");
        const size=buffer.readUInt32LE(offset);
        offset+=4;
        if(offset+size>buffer.length)throw new Error("Incomplete trace segment.");
        unreadable+=decodeSegment(buffer.subarray(offset,offset+size),pid,clockOffsetMs,entry=>entries.push(entry));
        offset+=size;
    }
    return {entries,unreadable};
}
async function decodeTraceFile(filename,pid,clockOffsetMs,{keep,manual,signal}) {
    const file=await fs.open(filename,"r");
    try {
        const {size}=await file.stat();
        let position=0;
        async function read(length) {
            if(position+length>size)throw new Error("Incomplete trace segment.");
            const block=Buffer.allocUnsafe(length);
            for(let filled=0;filled<length;){
                const {bytesRead}=await file.read(block,filled,length-filled,position);
                if(!bytesRead)throw new Error("Incomplete trace segment.");
                filled+=bytesRead;position+=bytesRead;
            }
            return block;
        }
        const header=await read(Math.min(1024,size));
        checkHeader(header,size);
        if(manual && size===1024 && !header.subarray(24,56).equals(emptyTraceDigest))
            throw new Error("The profiler has not finalized the empty trace. / 设备采集器尚未完成空采集文件的写入。");
        let records=[],count=0,unreadable=0;
        function retain(entry) {
            // Sanitize using the same evidence schema as HAR before retaining any body.
            const [record]=harRecords({log:{entries:[entry]}},"device");
            records[count%keep]=record;count++;
        }
        while(position<size){
            signal?.throwIfAborted();
            const length=(await read(4)).readUInt32LE();
            // Individual packets from the 4096-page Network Kit buffer are small. A
            // corrupt length in a multi-GiB trace must never allocate the extension heap.
            if(length>64*1024*1024)throw new Error("Unsupported profiler segment larger than 64 MiB. / 采集文件中存在超过 64 MiB 的不支持数据段。");
            unreadable+=decodeSegment(await read(length),pid,clockOffsetMs,retain);
        }
        if(count>keep){const first=count%keep;records=records.slice(first).concat(records.slice(0,first));}
        return {records,count,unreadable};
    } finally {await file.close();}
}
module.exports={decodeTrace,decodeTraceFile,emptyTraceDigest};
