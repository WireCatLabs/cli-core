import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR, pctl, RUNTIME } from "./common.ts"
const { openStore }=await import('../../dist/store/index.js')
const { searchStore,parseLucene }=await import('../../dist/services/index.js')
const { openSqlite }=await import('../../dist/store/sqlite/open.js')
const { matchQuery }=await import('../../dist/store/sqlite/lucene.js')
const n=Number(process.argv[2]),rounds=20
const file=join(DATA_DIR,`store-${n}-node`,'messages.db')
if (!Number.isInteger(n) || !existsSync(file)) throw new Error('generate/build the synthetic corpus first')
const store=await openStore({path:file})
await store.searchIndex.fillSearchIndex()
const account={provider:'max',account:'bench'}
const queries=[['exact','valencia'],['implicit AND','pasaporte contrato'],['OR','valencia OR whatsapp'],['NOT','valencia NOT whatsapp'],['phrase','"hola gracias"'],['term regex','text:/valencia/'],['scoped body regex','chat:42 AND body:/.*valencia.*/']] as const
const fingerprint=createHash('sha256').update(readFileSync(new URL('../../dist/store/sqlite/lucene.js',import.meta.url))).digest('hex')
const lines=[`\n### Lucene A1 ${RUNTIME}, ${n.toLocaleString('en')} messages\n`,`Executor SHA-256 ${fingerprint}; measured ${new Date().toISOString()}.\n`,`20 repeated requests; first request uses a new process but SQLite/OS pages may be warm after fill. Source all; result limit 20. RSS includes fill.\n`,`| Query | first ms | warm p50 ms | warm p95 ms | hits |`,`|---|---|---|---|---|`]
for (const [label,text] of queries) {
  const samples:number[]=[];let hits=0,cold=0
  for(let i=0;i<=rounds;i++) {
    const before=performance.now()
    const found=await searchStore(store,account,{text,language:'lucene',source:'all',limit:20})
    const elapsed=performance.now()-before
    hits=found.items.length
    if(i===0)cold=elapsed;else samples.push(elapsed)
  }
  lines.push(`| ${label} | ${cold.toFixed(2)} | ${pctl(samples,50).toFixed(2)} | ${pctl(samples,95).toFixed(2)} | ${hits} |`)
}
lines.push(`\nRSS ${Math.round(process.memoryUsage().rss/1048576)} MiB; no live messages or accounts used.\n`)
const sqlite=await openSqlite(file)
let plan:unknown[]=[]
const driver={close:()=>sqlite.database.close(),exec:(sql:string)=>sqlite.database.exec(sql),prepare:(sql:string)=>{
  const statement=sqlite.database.prepare(sql)
  return {get:(...params:unknown[])=>statement.get(...params),run:(...params:unknown[])=>statement.run(...params),all:(...params:unknown[])=>{
    if(sql.startsWith('SELECT m.pk AS pk,') && sql.includes('ORDER BY')) plan=sqlite.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    return statement.all(...params)
  }}
}}
await matchQuery({...sqlite,database:driver,now:Date.now},{root:parseLucene('valencia').root,accounts:[{provider:'max',account:'bench'},{provider:'telegram',account:'bench'},{provider:'whatsapp',account:'bench'}],limit:20})
lines.push(`\nEXPLAIN exact query:\n\n\`\`\`json\n${JSON.stringify(plan,null,2)}\n\`\`\`\n`)
const text=lines.join('\n')
appendFileSync(join(import.meta.dirname,'lucene-results.md'),text)
console.log(text)
await store.close();sqlite.database.close()
