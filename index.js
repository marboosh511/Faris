import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from './db.js';
import { requireAuth, signToken } from './auth.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
const app = express();
app.get('/', (req, res) => {
  res.sendFile('/app/index.html');
});
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
const allowed = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) { if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true); cb(new Error('Origin not allowed')); }, credentials: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));

const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const registerSchema = z.object({ username: z.string().trim().min(3).max(24).regex(/^[\p{L}\p{N}_-]+$/u), email: z.email().max(254), password: z.string().min(10).max(72), displayName: z.string().trim().min(2).max(40) });
const loginSchema = z.object({ login: z.string().trim().min(3).max(254), password: z.string().min(1).max(72) });
const horseSchema = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(300).default(''), breed: z.string().trim().max(80).default(''), coat: z.string().trim().max(50).default(''), ageYears: z.number().min(0).max(50).nullable().optional(), modelUrl: z.string().url().max(1000).or(z.literal('')).default('') });
const listingSchema = z.object({ horseId: z.uuid(), price: z.number().int().positive().max(9000000000000) });
const entrySchema = z.object({ tournamentCode: z.string().trim().min(2).max(60), horseId: z.uuid() });

app.get('/health', (req,res) => res.json({ ok: true, service: 'mamlakat-alkhayl-api' }));
app.post('/api/auth/register', wrap(async (req,res) => {
  const input = registerSchema.parse(req.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('INSERT INTO users(username,email,password_hash) VALUES($1,lower($2),$3) RETURNING id,username,email', [input.username,input.email,passwordHash]);
    await client.query('INSERT INTO player_profiles(user_id,display_name) VALUES($1,$2)', [u.rows[0].id,input.displayName]);
    await client.query('COMMIT');
    res.status(201).json({ token: signToken(u.rows[0]), user: u.rows[0] });
  } catch(e) { await client.query('ROLLBACK'); if(e.code==='23505') return res.status(409).json({error:'اسم اللاعب أو البريد مستخدم بالفعل.'}); throw e; }
  finally { client.release(); }
}));
app.post('/api/auth/login', wrap(async (req,res) => {
  const input = loginSchema.parse(req.body);
  const q = await pool.query('SELECT id,username,email,password_hash FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 1',[input.login]);
  if (!q.rowCount || !(await bcrypt.compare(input.password,q.rows[0].password_hash))) return res.status(401).json({error:'بيانات الدخول غير صحيحة.'});
  const user=q.rows[0]; delete user.password_hash;
  res.json({token:signToken(user),user});
}));
app.get('/api/me', requireAuth, wrap(async (req,res) => {
  const q=await pool.query('SELECT u.id,u.username,u.email,p.display_name,p.level FROM users u JOIN player_profiles p ON p.user_id=u.id WHERE u.id=$1',[req.user.id]);
  res.json({user:q.rows[0]});
}));
app.get('/api/horses', requireAuth, wrap(async (req,res) => {
  const q=await pool.query('SELECT id,name,description,breed,coat,age_years AS "ageYears",model_url AS "modelUrl",created_at AS "createdAt" FROM horses WHERE owner_id=$1 ORDER BY created_at',[req.user.id]);
  res.json({horses:q.rows});
}));
app.post('/api/horses', requireAuth, wrap(async (req,res) => {
  const h=horseSchema.parse(req.body);
  const q=await pool.query('INSERT INTO horses(owner_id,name,description,breed,coat,age_years,model_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,description,breed,coat,age_years AS "ageYears",model_url AS "modelUrl"',[req.user.id,h.name,h.description,h.breed,h.coat,h.ageYears ?? null,h.modelUrl]);
  res.status(201).json({horse:q.rows[0]});
}));
app.delete('/api/horses/:id', requireAuth, wrap(async (req,res) => {
  const q=await pool.query('DELETE FROM horses WHERE id=$1 AND owner_id=$2 RETURNING id',[req.params.id,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:'الحصان غير موجود في منقيتك.'});
  res.json({deleted:true});
}));
app.get('/api/market', requireAuth, wrap(async (req,res) => {
  const q=await pool.query(`SELECT l.id,l.horse_id AS "horseId",l.seller_id AS "sellerId",u.username AS seller,h.name AS "horseName",h.description,h.breed,h.coat,l.price,l.status,l.created_at AS "createdAt" FROM market_listings l JOIN horses h ON h.id=l.horse_id JOIN users u ON u.id=l.seller_id WHERE l.status='active' ORDER BY l.created_at DESC LIMIT 200`);
  res.json({listings:q.rows});
}));
app.post('/api/market', requireAuth, wrap(async (req,res) => {
  const x=listingSchema.parse(req.body);
  const q=await pool.query('INSERT INTO market_listings(horse_id,seller_id,price) SELECT id,owner_id,$3 FROM horses WHERE id=$1 AND owner_id=$2 RETURNING id,horse_id AS "horseId",price,status',[x.horseId,req.user.id,x.price]);
  if(!q.rowCount) return res.status(404).json({error:'الحصان غير مملوك لهذا الحساب.'});
  res.status(201).json({listing:q.rows[0]});
}));
app.delete('/api/market/:id', requireAuth, wrap(async (req,res) => {
  const q=await pool.query("UPDATE market_listings SET status='cancelled',updated_at=NOW() WHERE id=$1 AND seller_id=$2 AND status='active' RETURNING id",[req.params.id,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:'العرض غير موجود أو لا تملك صلاحية إلغائه.'});
  res.json({cancelled:true});
}));
app.post('/api/market/:id/buy', requireAuth, wrap(async (req,res) => {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const q=await client.query("SELECT id,horse_id,seller_id FROM market_listings WHERE id=$1 AND status='active' FOR UPDATE",[req.params.id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'العرض لم يعد متاحاً.'});}
    const row=q.rows[0];
    if(row.seller_id===req.user.id){await client.query('ROLLBACK');return res.status(400).json({error:'لا يمكنك شراء حصانك.'});}
    await client.query('UPDATE horses SET owner_id=$1 WHERE id=$2',[req.user.id,row.horse_id]);
    await client.query("UPDATE market_listings SET status='sold',buyer_id=$1,updated_at=NOW() WHERE id=$2",[req.user.id,row.id]);
    await client.query('COMMIT');
    res.json({purchased:true,horseId:row.horse_id});
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}));
app.get('/api/tournaments/:code/entries', requireAuth, wrap(async (req,res) => {
  const q=await pool.query('SELECT e.id,e.horse_id AS "horseId",h.name AS "horseName",u.username AS owner,e.created_at AS "createdAt" FROM tournament_entries e JOIN horses h ON h.id=e.horse_id JOIN users u ON u.id=e.owner_id WHERE e.tournament_code=$1 ORDER BY e.created_at',[req.params.code]);
  res.json({entries:q.rows});
}));
app.post('/api/tournaments/entries', requireAuth, wrap(async (req,res) => {
  const x=entrySchema.parse(req.body);
  const q=await pool.query('INSERT INTO tournament_entries(tournament_code,horse_id,owner_id) SELECT $1,id,owner_id FROM horses WHERE id=$2 AND owner_id=$3 RETURNING id,tournament_code AS "tournamentCode",horse_id AS "horseId"',[x.tournamentCode,x.horseId,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:'الحصان غير موجود في منقيتك.'});
  res.status(201).json({entry:q.rows[0]});
}));
app.delete('/api/tournaments/entries/:id', requireAuth, wrap(async (req,res) => {
  const q=await pool.query('DELETE FROM tournament_entries WHERE id=$1 AND owner_id=$2 RETURNING id',[req.params.id,req.user.id]);
  if(!q.rowCount) return res.status(404).json({error:'التسجيل غير موجود.'});
  res.json({removed:true});
}));

app.use((err,req,res,next)=>{
  if(err instanceof z.ZodError) return res.status(400).json({error:'البيانات المدخلة غير صحيحة.',details:err.issues.map(x=>({field:x.path.join('.'),message:x.message}))});
  if(err.code==='23505') return res.status(409).json({error:'هذا السجل موجود بالفعل.'});
  console.error(err);
  res.status(500).json({error:'حدث خطأ في الخادم.'});
});
const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log(`Mamlakat Alkhayl API listening on ${port}`));
