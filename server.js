// FalconTrader paper-trading engine, phase 1. One endpoint (/hook) takes FTT ZCT alerts + 1m BAR feed.
// Accounts: MIRROR follows indicator messages; REAL resolves TP/SL from 1m bars. Same costs on both.
const express=require('express'),Db=require('better-sqlite3'),path=require('path');
const SECRET=process.env.FTT_SECRET||'CHANGE_ME',START=50000;let BE=process.env.BE==='1';
const S={MNQ:{tick:.25,pv:2,qty:2,comm:.5,slip:1},MGC:{tick:.1,pv:10,qty:2,comm:.5,slip:1}}; // pv = $ per 1.0 price point; edit qty/comm/slip here
const db=new Db(process.env.DB_PATH||'paper.db');
db.exec(`create table if not exists t(id integer primary key,acct text,sym text,side int,t0 int,entry real,sl real,sl0 real,tp1 real,tp2 real,q int,qo int,tp1d int default 0,gross real default 0,comm real default 0,t1 int,day text,lat int)`);
const sym=s=>/^MGC/i.test(s)?'MGC':/^MNQ/i.test(s)?'MNQ':null,pend={},q1=t=>t.q>1?Math.floor(t.q/2):1;
const open=(a,y)=>db.prepare('select * from t where acct=? and sym=? and qo>0').get(a,y);
// Day = UTC date, because 00:00 UTC is exactly 05:30 IST. A trade is booked on the day its last leg exits.
function fill(t,n,px,stop){const c=S[t.sym];n=Math.min(n,t.qo);if(stop)px-=t.side*c.slip*c.tick;
  const qo=t.qo-n,now=Date.now();
  db.prepare('update t set gross=gross+?,comm=comm+?,qo=?,t1=?,day=? where id=?').run((px-t.entry)*t.side*n*c.pv,n*c.comm,qo,qo?null:now,qo?null:new Date(now).toISOString().slice(0,10),t.id)}
function openT(a,m,y){const c=S[y],side=m.direction=='BUY'?1:-1,stp=/STOP/.test(pend[y+m.direction]||''),
  e=+m.entry+(stp?side*c.slip*c.tick:0),lat=m.signal_fired_time?Date.now()-Date.parse(m.signal_fired_time.replace(' ','T')+'+05:30'):null;
  db.prepare('insert into t(acct,sym,side,t0,entry,sl,sl0,tp1,tp2,q,qo,comm,lat) values(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a,y,side,Date.now(),e,+m.sl,+m.sl,+m.tp1,+m.tp2,c.qty,c.qty,c.qty*c.comm,lat)}
const app=express();
app.post('/hook',express.text({type:'*/*'}),(q,r)=>{let m;try{m=JSON.parse(q.body)}catch{return r.sendStatus(400)}
  if(m.secret!==SECRET)return r.sendStatus(403);const y=sym(m.symbol),T=m.type;if(!y)return r.sendStatus(422);
  if(T=='BAR'){const z=open('REAL',y);
    if(z&&+m.t>=Math.floor(z.t0/6e4)*6e4+6e4){ // skip the entry minute: intrabar order unknown
      const hit=(l,tp)=>(z.side>0)==tp?+m.h>=l:+m.l<=l;
      if(hit(z.sl,0))fill(z,z.qo,z.sl,1);
      else if(!z.tp1d){if(hit(z.tp1,1)){fill(z,q1(z),z.tp1,0);db.prepare('update t set tp1d=1,sl=? where id=?').run(BE?z.entry:z.sl,z.id)}}
      else if(hit(z.tp2,1))fill(z,z.qo,z.tp2,0)}}
  else if(T=='PENDING')pend[y+m.direction]=m.order_type;
  else if(T=='PENDING_CANCEL')delete pend[y+m.direction];
  else if(T=='ENTRY')['MIRROR','REAL'].forEach(a=>{const o=open(a,y);if(o)fill(o,o.qo,+m.entry,0);openT(a,m,y)}); // reversal closes old trade at entry price
  else{const o=open('MIRROR',y);
    if(T=='TP1'){BE=m.be_active=='true';if(o){fill(o,q1(o),+m.tp1,0);db.prepare('update t set tp1d=1,sl=? where id=?').run(BE?o.entry:o.sl,o.id)}}
    else{if(o)T=='TP2'?fill(o,o.qo,+m.tp2,0):T=='SL'?fill(o,o.qo,+m.sl,1):fill(o,o.qo,o.entry,1);
      const z=open('REAL',y);if(z)T=='TP2'?fill(z,z.qo,+m.tp2,0):T=='SL'?fill(z,z.qo,+m.sl,1):fill(z,z.qo,z.entry,1)}} // indicator says trade ended: close REAL too
  r.sendStatus(200)});
app.get('/api/stats',(q,r)=>{const o={};
  for(const a of['MIRROR','REAL']){const all=db.prepare('select * from t where acct=? order by id').all(a),net=t=>t.gross-t.comm,
    cl=all.filter(t=>!t.qo).sort((x,y)=>x.t1-y.t1);let eq=START,pk=START,dd=0;const days={},curve=cl.map(t=>{eq+=net(t);pk=Math.max(pk,eq);dd=Math.max(dd,pk-eq);days[t.day]=(days[t.day]||0)+net(t);return[t.t1,eq]}),
    gp=cl.filter(t=>net(t)>0).reduce((s,t)=>s+net(t),0),gl=cl.filter(t=>net(t)<=0).reduce((s,t)=>s-net(t),0),
    R=cl.map(t=>net(t)/(Math.abs(t.entry-t.sl0)*S[t.sym].pv*t.q)),bySym={};
    cl.forEach(t=>{bySym[t.sym]=(bySym[t.sym]||0)+net(t)});
    o[a]={n:cl.length,wins:cl.filter(t=>net(t)>0).length,net:eq-START,pf:gl?gp/gl:null,avgR:R.length?R.reduce((s,x)=>s+x,0)/R.length:0,dd,curve,days,bySym,open:all.filter(t=>t.qo)}}
  const L=db.prepare("select lat from t where acct='MIRROR' and lat is not null").all().map(x=>x.lat);
  o.lat={n:L.length,avg:L.length?L.reduce((s,x)=>s+x,0)/L.length:null,max:L.length?Math.max(...L):null};r.json(o)});
app.use(express.static(path.join(__dirname,'public')));
app.listen(process.env.PORT||3000);
