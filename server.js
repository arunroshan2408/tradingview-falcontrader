// FalconTrader paper-trading engine v2: any symbol, broker-style data API. MIRROR follows indicator messages; REAL resolves TP/SL from 1m bars.
const express=require('express'),Db=require('better-sqlite3'),path=require('path');
const SECRET=process.env.FTT_SECRET||'CHANGE_ME';let BE=process.env.BE==='1';
const db=new Db(process.env.DB_PATH||'paper.db');
db.exec(`create table if not exists t(id integer primary key,acct text,sym text,side int,t0 int,entry real,sl real,sl0 real,tp1 real,tp2 real,q int,qo int,tp1d int default 0,gross real default 0,comm real default 0,t1 int,day text,lat int);
create table if not exists inst(sym text primary key,tick real,pv real,qty int,comm real,slip real,ok int);
create table if not exists cfg(k text primary key,v text)`);
for(const c of['xs real default 0','xn int default 0'])try{db.exec('alter table t add column '+c)}catch{}
const SEED={MNQ1:[.25,2,2],MGC1:[.1,10,2]},last={},pend={},norm=s=>String(s||'').toUpperCase().replace(/^.*:/,'').replace(/!$/,''),q1=t=>t.q>1?Math.floor(t.q/2):1;
// Unknown symbols are created on first sight: tick/pv come from the bar feed (syminfo), qty/comm/slip are editable in dashboard Settings.
function ins(y){let r=db.prepare('select * from inst where sym=?').get(y);if(!r){const d=SEED[y];db.prepare('insert into inst values(?,?,?,?,?,?,?)').run(y,d?d[0]:.01,d?d[1]:1,d?d[2]:1,.5,1,d?1:0);r=db.prepare('select * from inst where sym=?').get(y)}return r}
const open=(a,y)=>db.prepare('select * from t where acct=? and sym=? and qo>0').get(a,y);
// Day = UTC date (00:00 UTC is 05:30 IST). A trade is booked on the day its last leg exits.
function fill(t,n,px,stop){const c=ins(t.sym);n=Math.min(n,t.qo);if(stop)px-=t.side*c.slip*c.tick;const qo=t.qo-n,now=Date.now();
  db.prepare('update t set gross=gross+?,comm=comm+?,qo=?,xs=xs+?,xn=xn+?,t1=?,day=? where id=?').run((px-t.entry)*t.side*n*c.pv,n*c.comm,qo,px*n,n,qo?null:now,qo?null:new Date(now).toISOString().slice(0,10),t.id)}
function openT(a,m,y){const c=ins(y),side=m.direction=='BUY'?1:-1,stp=/STOP/.test(pend[y+m.direction]||''),
  e=+m.entry+(stp?side*c.slip*c.tick:0),lat=m.signal_fired_time?Date.now()-Date.parse(m.signal_fired_time.replace(' ','T')+'+05:30'):null;
  db.prepare('insert into t(acct,sym,side,t0,entry,sl,sl0,tp1,tp2,q,qo,comm,lat) values(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a,y,side,Date.now(),e,+m.sl,+m.sl,+m.tp1,+m.tp2,c.qty,c.qty,c.qty*c.comm,lat)}
const app=express();
app.post('/hook',express.text({type:'*/*'}),(q,r)=>{let m;try{m=JSON.parse(q.body)}catch{return r.sendStatus(400)}
  if(m.secret!==SECRET){console.log('403 wrong secret, symbol',m.symbol);return r.sendStatus(403)}const y=norm(m.symbol),T=m.type;if(!y)return r.sendStatus(422);if(T!='BAR')console.log('hook',T,y,m.direction||'');
  if(T=='BAR'){last[y]={p:+m.c,t:+m.t};const c=ins(y);if(!c.ok&&+m.pv)db.prepare('update inst set tick=?,pv=?,ok=1 where sym=?').run(+m.tick||.01,+m.pv,y);
    const z=open('REAL',y);
    if(z&&+m.t>=Math.floor(z.t0/6e4)*6e4+6e4){ // skip the entry minute: intrabar order unknown
      const hit=(l,tp)=>(z.side>0)==tp?+m.h>=l:+m.l<=l;
      if(hit(z.sl,0))fill(z,z.qo,z.sl,1);
      else if(!z.tp1d){if(hit(z.tp1,1)){fill(z,q1(z),z.tp1,0);db.prepare('update t set tp1d=1,sl=? where id=?').run(BE?z.entry:z.sl,z.id)}}
      else if(hit(z.tp2,1))fill(z,z.qo,z.tp2,0)}}
  else if(T=='PENDING')pend[y+m.direction]=m.order_type;
  else if(T=='PENDING_CANCEL')delete pend[y+m.direction];
  else if(T=='ENTRY')['MIRROR','REAL'].forEach(a=>{const o=open(a,y);if(o)fill(o,o.qo,+m.entry,0);openT(a,m,y)});
  else if(['TP1','TP2','SL','BE_EXIT'].includes(T)){const o=open('MIRROR',y); // ZONE and unknown types must never close trades
    if(T=='TP1'){BE=m.be_active=='true';if(o){fill(o,q1(o),+m.tp1,0);db.prepare('update t set tp1d=1,sl=? where id=?').run(BE?o.entry:o.sl,o.id)}}
    else{if(o)T=='TP2'?fill(o,o.qo,+m.tp2,0):T=='SL'?fill(o,o.qo,+m.sl,1):fill(o,o.qo,o.entry,1);
      let z=open('REAL',y);if(z){if(T=='TP2'&&!z.tp1d){fill(z,q1(z),z.tp1,0);z=open('REAL',y)}if(z)T=='TP2'?fill(z,z.qo,+m.tp2,0):T=='SL'?fill(z,z.qo,+m.sl,1):fill(z,z.qo,z.entry,1)}}}
  r.sendStatus(200)});
app.get('/api/data',(q,r)=>{const c=db.prepare("select v from cfg where k='cap'").get();
  r.json({trades:db.prepare('select * from t order by id desc limit 3000').all(),inst:db.prepare('select * from inst order by sym').all(),cap:c?+c.v:50000,last})});
app.post('/api/set',express.json(),(q,r)=>{const b=q.body||{};if(b.secret!==SECRET)return r.sendStatus(403);
  if(+b.cap>0)db.prepare("insert or replace into cfg values('cap',?)").run(String(+b.cap));
  if(b.sym){ins(b.sym);db.prepare('update inst set tick=?,pv=?,qty=?,comm=?,slip=?,ok=1 where sym=?').run(+b.tick,+b.pv,Math.max(1,+b.qty|0),+b.comm,+b.slip,b.sym)}
  r.sendStatus(200)});
app.use(express.static(path.join(__dirname,'public')));
app.listen(process.env.PORT||3000);
