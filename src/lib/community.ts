import { emitActivityEvent } from './activity';
import { db, auth, checkIsAdmin } from './firebase';
import { 
  collection, collectionGroup, doc, setDoc, getDoc, updateDoc, getDocs, query, where, orderBy, deleteDoc, writeBatch, limit, serverTimestamp, onSnapshot, increment, runTransaction, documentId
} from 'firebase/firestore';
import { CommunityUser, CommunityPost, CommunityComment, UserSavedItem, BookmarkCollection, CarouselSlide, Notification } from '../types';
import { isPlatformModerator } from './social';
import { getNotificationPreferences } from './account';
import { optimizedGetDoc, optimizedGetDocs, invalidateFirestoreDocument, isFirestoreQuotaError } from './firestoreOptimization';


function mapDocDates(data: any) {
  if (!data) return data;
  const res = { ...data };
  if (res.createdAt?.toDate) res.createdAt = res.createdAt.toDate().toISOString();
  if (res.updatedAt?.toDate) res.updatedAt = res.updatedAt.toDate().toISOString();
  if (res.readAt?.toDate) res.readAt = res.readAt.toDate().toISOString();
  return res;
}
export enum OperationType {
  CREATE = 'create', UPDATE = 'update', DELETE = 'delete', LIST = 'list', GET = 'get', WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  try { const k='offscrpt:health:failed-writes:v1'; localStorage.setItem(k,String(Number(localStorage.getItem(k)||0)+1)); window.dispatchEvent(new CustomEvent('offscrpt:health-failed-write',{detail:errInfo})); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
  throw new Error(JSON.stringify(errInfo));
}


function extractMentions(text: string): string[] {
  return Array.from(new Set((text.match(/@[a-zA-Z0-9_]{3,30}/g) || []).map(v => v.slice(1).toLowerCase())));
}

export function extractHashtags(text: string): string[] {
  return Array.from(new Set((text.match(/#[a-zA-Z0-9_]{2,40}/g) || []).map(v => v.slice(1).toLowerCase())));
}

async function createNotification(userId: string, data: Omit<Notification, 'id' | 'createdAt' | 'read'>): Promise<void> {
  if (!userId || userId === data.actorId) return;
  try {
    const prefs = await getNotificationPreferencesForUser(userId);
    const allowed = data.type === 'comment' ? prefs.comments
      : data.type === 'reply' ? prefs.replies
      : data.type === 'mention' ? prefs.mentions
      : data.type === 'follow' ? prefs.follows
      : ['upvote', 'verification', 'repost'].includes(data.type) ? prefs.reactions
      : true;
    if (!allowed) return;
  } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
  const id = generateId();
  await setDoc(doc(db, 'users', userId, 'notifications', id), { ...data, read: false, createdAt: serverTimestamp() });
}

const notificationPreferenceCache = new Map<string, { expiresAt: number; value: any }>();

async function getNotificationPreferencesForUser(userId: string) {
  const cached = notificationPreferenceCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const fallback = { comments: true, replies: true, mentions: true, follows: true, reactions: true, productNews: true };
  try {
    const snap = await optimizedGetDoc(doc(db, 'users', userId, 'preferences', 'notifications'), { ttlMs: 300_000, allowStaleOnQuota: true });
    const value = { ...fallback, ...(snap.exists() ? snap.data() : {}) };
    notificationPreferenceCache.set(userId, { value, expiresAt: Date.now() + 300_000 });
    return value;
  } catch {
    return cached?.value || fallback;
  }
}

async function createAdminNotification(data: any): Promise<void> {
  if (!auth.currentUser || !data?.actorId) return;
  try { await setDoc(doc(collection(db, 'admin_notifications')), { ...data, read: false, createdAt: serverTimestamp() }); }
  catch (e) { console.warn('Admin notification creation failed:', e); }
}

/** Subscribe to unread notifications for the signed-in user, including admin moderation alerts. */
export function subscribeUnreadNotificationCount(userId: string, callback: (count: number) => void): () => void {
  if (!userId) { callback(0); return () => {}; }
  let userCount = 0; let adminCount = 0; let active = true;
  const emit = () => callback(userCount + adminCount);
  const unsubUser = onSnapshot(query(collection(db, 'users', userId, 'notifications'), where('read', '==', false)), snap => { userCount = snap.size; emit(); }, err => { console.warn('Unread notification subscription failed:', err); userCount = 0; emit(); });
  let unsubAdmin:()=>void = () => {};
  isPlatformModerator(userId).then(mod => {
    if (!active) return;
    if (checkIsAdmin(auth.currentUser?.email) || mod) {
      unsubAdmin = onSnapshot(query(collection(db, 'admin_notifications'), where('read', '==', false)), snap => { adminCount = snap.size; emit(); }, err => { console.warn('Admin notification subscription failed:', err); adminCount = 0; emit(); });
    }
  }).catch((error) => console.warn('OFFSCRPT recoverable operation failed:', error));
  return () => { active = false; unsubUser(); unsubAdmin(); };
}

async function notifyMentions(text: string, actor: CommunityUser, targetType: 'post' | 'comment', targetId: string): Promise<void> {
  const handles = extractMentions(text);
  if (!handles.length) return;
  await Promise.all(handles.map(async username => {
    try {
      // Primary lookup uses the canonical username reservation. The users fallback
      // also supports older profiles that predate username reservation documents.
      const usernameSnap = await getDoc(doc(db, 'usernames', username));
      let uid = usernameSnap.exists() ? usernameSnap.data()?.uid : null;
      if (!uid) {
        const userSnap = await getDocs(query(collection(db, 'users'), where('username', '==', username), limit(1)));
        uid = userSnap.empty ? null : userSnap.docs[0].id;
      }
      if (uid) {
        await createNotification(uid, {
          type: 'mention', actorId: actor.uid, actorUsername: actor.username,
          actorName: actor.displayName, actorAvatar: actor.photoURL || '',
          message: `mentioned you in a ${targetType}`, targetType, targetId
        });
      }
    } catch (e) { console.warn('Mention notification failed:', e); }
  }));
}

export function subscribeUserNotifications(userId: string, callback: (items: Notification[]) => void): () => void {
  if (!userId) { callback([]); return () => {}; }
  const userQuery = query(collection(db, 'users', userId, 'notifications'), orderBy('createdAt', 'desc'), limit(100));
  let userItems: Notification[] = [];
  let adminItems: Notification[] = [];
  let active = true;
  const emit = () => {
    if (!active) return;
    callback([...userItems, ...adminItems].sort((a,b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0,100));
  };
  const unsubUser = onSnapshot(userQuery, snap => {
    userItems = snap.docs.map(d => ({ id:d.id, ...mapDocDates(d.data()) } as Notification));
    emit();
  }, () => { userItems = []; emit(); });
  let unsubAdmin: (() => void) | undefined;
  isPlatformModerator(userId).then(mod => {
    if (!active || (!checkIsAdmin(auth.currentUser?.email) && !mod)) return;
    unsubAdmin = onSnapshot(query(collection(db, 'admin_notifications'), orderBy('createdAt', 'desc'), limit(100)), snap => {
      adminItems = snap.docs.map(d => ({ id:`admin:${d.id}`, ...mapDocDates(d.data()) } as Notification));
      emit();
    }, () => { adminItems = []; emit(); });
  }).catch((error) => console.warn('OFFSCRPT recoverable operation failed:', error));
  return () => { active = false; unsubUser(); if (unsubAdmin) unsubAdmin(); };
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  if (!userId || !notificationId) return;
  if (notificationId.startsWith('admin:')) {
    await updateDoc(doc(db, 'admin_notifications', notificationId.slice(6)), { read: true });
  } else {
    await updateDoc(doc(db, 'users', userId, 'notifications', notificationId), { read: true });
  }
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  if (!userId) return;
  const batch = writeBatch(db);
  const userSnap = await getDocs(query(collection(db, 'users', userId, 'notifications'), where('read', '==', false), limit(100)));
  userSnap.docs.forEach(d => batch.update(d.ref, { read: true }));
  if (checkIsAdmin(auth.currentUser?.email) || await isPlatformModerator(userId)) {
    try {
      const adminSnap = await getDocs(query(collection(db, 'admin_notifications'), where('read', '==', false), limit(100)));
      adminSnap.docs.forEach(d => batch.update(d.ref, { read: true }));
    } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
  }
  if (!batch) return;
  await batch.commit();
}

export async function getUserNotifications(userId: string): Promise<Notification[]> {
  const snap = await getDocs(query(collection(db, 'users', userId, 'notifications'), orderBy('createdAt', 'desc'), limit(100)));
  const items = snap.docs.map(d => ({ id: d.id, ...mapDocDates(d.data()) } as Notification));
  if (checkIsAdmin(auth.currentUser?.email) || await isPlatformModerator(userId)) {
    try {
      const adminSnap = await getDocs(query(collection(db, 'admin_notifications'), orderBy('createdAt', 'desc'), limit(100)));
      const adminItems = adminSnap.docs.map(d => ({ id: `admin:${d.id}`, ...mapDocDates(d.data()) } as Notification));
      return [...items, ...adminItems].sort((a,b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()).slice(0,100);
    } catch (e) { console.warn('Admin notifications load failed:', e); }
  }
  return items;
}

export async function markNotificationsRead(userId: string): Promise<void> {
  const batch = writeBatch(db);
  const snap = await getDocs(query(collection(db, 'users', userId, 'notifications'), where('read', '==', false), limit(100)));
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  if (checkIsAdmin(auth.currentUser?.email) || await isPlatformModerator(userId)) {
    try {
      const adminSnap = await getDocs(query(collection(db, 'admin_notifications'), where('read', '==', false), limit(100)));
      adminSnap.docs.forEach(d => batch.update(d.ref, { read: true }));
    } catch (e) { console.warn('Admin notifications mark-read failed:', e); }
  }
  if (snap.size > 0 || checkIsAdmin(auth.currentUser?.email)) await batch.commit();
}

export async function saveCommunityDraft(userId: string, data: { type: 'discussion' | 'blog'; title: string; content: string; mediaUrls?: string[] }): Promise<void> {
  await setDoc(doc(db, 'users', userId, 'drafts', 'community'), { ...data, updatedAt: serverTimestamp() });
}

export async function getCommunityDraft(userId: string): Promise<{ type: 'discussion' | 'blog'; title: string; content: string; mediaUrls?: string[] } | null> {
  const snap = await getDoc(doc(db, 'users', userId, 'drafts', 'community'));
  return snap.exists() ? snap.data() as any : null;
}

export async function clearCommunityDraft(userId: string): Promise<void> {
  await deleteDoc(doc(db, 'users', userId, 'drafts', 'community'));
}
export async function getCommunityProfile(uid: string): Promise<CommunityUser | null> {
  const p = `users/${uid}`;
  try {
    if (!uid) return null;
    const snap = await optimizedGetDoc(doc(db, 'users', uid), { ttlMs: 60_000, allowStaleOnQuota: true });
    if (snap.exists()) {
      return mapDocDates(snap.data()) as CommunityUser;
    }
    return null;
  } catch (error) {
    if (isFirestoreQuotaError(error)) {
      console.warn('Profile read suppressed by Firestore quota protection:', uid);
      return null;
    }
    handleFirestoreError(error, OperationType.GET, p);
    return null;
  }
}

export async function getProfileByUsername(username: string): Promise<CommunityUser | null> {
  const clean = normalizeUsername(username);
  if (!clean) return null;
  try {
    // First resolve the caller's own canonical profile. This repairs the most
    // important failure mode: a user can still open their profile immediately
    // after changing a handle even if its public projection is missing/stale.
    const currentUid = auth.currentUser?.uid || '';
    if (currentUid) {
      const own = await getCommunityProfile(currentUid);
      if (own?.username && normalizeUsername(own.username) === clean) {
        try { await upsertPublicProfile(own); } catch (e) { console.warn('Own public profile repair failed:', e); }
        return own;
      }
    }

    // Public profile lookup never requires authentication. It is keyed by the
    // claimed handle and contains only public presentation fields.
    const publicSnap = await getDoc(doc(db, 'publicProfiles', clean));
    if (publicSnap.exists()) {
      const publicProfile = mapDocDates(publicSnap.data()) as CommunityUser;
      // Public viewers receive only public presentation data. The private
      // Firebase UID is never read from the public profile directory.
      if (currentUid && publicProfile.username && normalizeUsername(publicProfile.username) === clean) {
        const own = await getCommunityProfile(currentUid);
        if (own?.uid === currentUid && normalizeUsername(own.username || '') === clean) {
          return { ...publicProfile, ...own } as CommunityUser;
        }
        const targetUid = await resolvePublicHandleUid(clean);
        if (targetUid) (publicProfile as any).uid = targetUid;
      }
      return publicProfile;
    }

    // Preserve old public links after a handle change. The alias contains only the
    // successor handle and never exposes the private Firebase UID.
    try {
      const aliasSnap = await getDoc(doc(db, 'handleAliases', clean));
      const nextHandle = aliasSnap.exists() ? normalizeUsername(String(aliasSnap.data()?.newUsername || '')) : '';
      if (nextHandle && nextHandle !== clean) {
        const redirected = await getProfileByUsername(nextHandle);
        if (redirected) return redirected;
      }
    } catch (aliasError) {
      console.warn('Handle alias lookup skipped:', aliasError);
    }

    // Legacy repair path. Only the account owner or Master Admin may read the
    // private user document and rebuild the missing public projection.
    const handleSnap = await getDoc(doc(db, 'usernames', clean));
    const handleUid = handleSnap.exists() ? String(handleSnap.data()?.uid || '') : '';
    if (handleUid) {
      const canReadPrivateIdentity = !!auth.currentUser && (
        auth.currentUser.uid === handleUid || checkIsAdmin(auth.currentUser.email)
      );
      if (canReadPrivateIdentity) {
        const legacy = await getCommunityProfile(handleUid);
        if (legacy?.username && normalizeUsername(legacy.username) === clean) {
          try { await upsertPublicProfile(legacy); } catch (e) { console.warn('Legacy public profile repair failed:', e); }
          return legacy;
        }
      }
    }
    return null;
  } catch (error) {
    console.warn('Public profile lookup failed:', error);
    return null;
  }
}

function normalizeUsername(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]/g, '').slice(0, 30);
}

function validateUsername(value: string): string {
  const username = normalizeUsername(value);
  if (username && (username.length < 3 || username.length > 30)) {
    throw new Error('Handle must be 3–30 characters.');
  }
  return username;
}

function generateNewUserDisplayName(): string {
  const prefixes = ['Builder', 'Member', 'Creator', 'Reader', 'Dev'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = Math.floor(1000 + Math.random() * 9000);
  return `${prefix} ${number}`;
}

async function chooseAvailableUsername(base: string): Promise<string> {
  const cleanBase = normalizeUsername(base) || 'user';
  const root = cleanBase.slice(0, 24) || 'user';
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? root : `${root}${i}`.slice(0, 30);
    const snap = await getDoc(doc(db, 'usernames', candidate));
    if (!snap.exists()) return candidate;
  }
  return `${root.slice(0, 26)}_${Date.now().toString().slice(-3)}`;
}

/**
 * Returns the cloud profile for a signed-in Google account, creating one
 * automatically when this is the account's first visit. New accounts get a
 * temporary random display name; the @handle remains explicitly unclaimed until
 * the user chooses one.
 */
const handleUidCache = new Map<string, { expiresAt: number; uid: string }>();

async function resolvePublicHandleUid(username: string): Promise<string> {
  if (!auth.currentUser) return '';
  const clean = normalizeUsername(username);
  if (!clean) return '';
  const cached = handleUidCache.get(clean);
  if (cached && cached.expiresAt > Date.now()) return cached.uid;
  try {
    const reservation = await optimizedGetDoc(doc(db, 'usernames', clean), { ttlMs: 300_000, allowStaleOnQuota: true });
    const uid = reservation.exists() ? String(reservation.data()?.uid || '') : '';
    handleUidCache.set(clean, { uid, expiresAt: Date.now() + 300_000 });
    return uid;
  } catch (error) {
    console.warn('Public handle UID resolution skipped:', error);
    return cached?.uid || '';
  }
}

export async function getAllCommunityUsers(): Promise<CommunityUser[]> {
  try {
    const snap = await optimizedGetDocs(
      'publicProfiles:all',
      () => getDocs(collection(db, 'publicProfiles')),
      { ttlMs: 120_000, allowStaleOnQuota: true },
    );
    const base = snap.docs.map(d => mapDocDates(d.data()) as CommunityUser)
      .filter(u => !!u?.username);
    if (!auth.currentUser) return base.sort((a, b) => a.username.localeCompare(b.username));
    // Identity enrichment is still performed, but each username lookup is cached
    // by getProfileByUsername/resolvePublicHandleUid callers to avoid stampeding reads.
    const enriched = await Promise.all(base.map(async u => {
      const uid = await resolvePublicHandleUid(u.username);
      return uid ? ({ ...u, uid } as CommunityUser) : u;
    }));
    return enriched.sort((a, b) => a.username.localeCompare(b.username));
  } catch (error) {
    console.warn('Failed to load public community users:', error);
    return [];
  }
}

export async function getPublicProfilesByUsernames(usernames: string[]): Promise<Record<string, CommunityUser>> {
  const clean = Array.from(new Set(usernames.map(normalizeUsername).filter(Boolean))).slice(0, 100);
  const out: Record<string, CommunityUser> = {};
  for (let i = 0; i < clean.length; i += 10) {
    const batch = clean.slice(i, i + 10);
    try {
      const snap = await getDocs(query(collection(db, 'publicProfiles'), where(documentId(), 'in', batch)));
      for (const docSnap of snap.docs) {
        const profile = mapDocDates(docSnap.data()) as CommunityUser;
        if (profile?.username) out[normalizeUsername(profile.username)] = profile;
      }
    } catch (error) {
      console.warn('Batched public profile lookup failed:', error);
    }
  }
  return out;
}

export async function getAllCommentsForSearch(): Promise<Array<{ id: string; content: string; authorId: string; authorUsername: string; authorName: string; postId?: string; articleSlug?: string; createdAt: string }>> {
  try {
    const snap = await getDocs(collectionGroup(db, 'comments'));
    return snap.docs.flatMap(d => {
      const data: any = d.data();
      if (data.isHidden === true || data.isDeleted === true) return [];
      const path = d.ref.path.split('/');
      return [{
        id: d.id, content: data.content || '', authorId: data.authorId || '',
        authorUsername: data.authorUsername || '', authorName: data.authorName || '',
        postId: path[0] === 'posts' ? path[1] : undefined,
        articleSlug: path[0] === 'articles' ? path[1] : undefined,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString())
      }];
    });
  } catch (error) {
    console.warn('Failed to load comments for search:', error);
    return [];
  }
}

export async function ensureCommunityProfileForUser(user: import('firebase/auth').User): Promise<CommunityUser> {
  if (!auth.currentUser || auth.currentUser.uid !== user.uid) throw new Error('Must be logged in');

  const existing = await getCommunityProfile(user.uid);
  if (existing) {
    if (existing.username) {
      const syncKey = `offscrpt:public-profile-sync:${user.uid}`;
      let recentlySynced = false;
      try { recentlySynced = Number(sessionStorage.getItem(syncKey) || 0) > Date.now() - 900_000; } catch (error) { console.warn('Public profile sync session marker unavailable:', error); }
      if (!recentlySynced) {
        try {
          await upsertPublicProfile(existing);
          try { sessionStorage.setItem(syncKey, String(Date.now())); } catch (error) { console.warn('Public profile sync session marker write unavailable:', error); }
        } catch (error) { console.warn('Public profile projection refresh skipped:', error); }
      }
    }
    if (checkIsAdmin(user.email) && existing.platformRole !== 'master_admin') {
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          platformRole: 'master_admin', role: 'Master Admin', email: user.email || '', updatedAt: serverTimestamp()
        });
        existing.platformRole = 'master_admin'; existing.role = 'Master Admin'; existing.email = user.email || '';
      } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    }
    return existing;
  }

  // IMPORTANT: a Google display name is not a claimed @handle. New accounts start
  // with an empty username and no username reservation document. The user must
  // explicitly claim a unique handle through the claim modal/profile settings.
  const profile: any = {
    uid: user.uid,
    username: '',
    displayName: generateNewUserDisplayName(),
    photoURL: user.photoURL || '',
    bio: 'Software builder & writer',
    themeColor: '#D97706',
    role: checkIsAdmin(user.email) ? 'Master Admin' : '',
    platformRole: checkIsAdmin(user.email) ? 'master_admin' : 'member',
    email: user.email || '',
    isAuthor: false,
    isVerified: false,
    verificationColor: '#2196F3',
    followersCount: 0,
    followingCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const userRef = doc(db, 'users', user.uid);
  await runTransaction(db, async tx => {
    const userSnap = await tx.get(userRef);
    if (userSnap.exists()) return;
    tx.set(userRef, profile);
  });

  const resolved = await getCommunityProfile(user.uid);
  if (!resolved) throw new Error('Unable to create your community profile.');
  if (resolved.username) {
    await upsertPublicProfile(resolved);
    try { await ensureFollowingAuthor(user.uid, resolved.username); } catch (err) { console.warn('Auto-follow author failed:', err); }
  }
  return resolved;
}

export async function upsertPublicProfile(profile: CommunityUser): Promise<void> {
  const username = normalizeUsername(profile.username || '');
  if (!username) return;
  // Public profile intentionally excludes email, roles, UID, moderation state,
  // and other private/admin-only fields. The canonical private user document
  // remains the authority for identity and authorization.
  await setDoc(doc(db, 'publicProfiles', username), {
    username, displayName: profile.displayName || 'User', photoURL: profile.photoURL || '',
    coverImageUrl: profile.coverImageUrl || '', websiteUrl: profile.websiteUrl || '',
    location: profile.location || '', socialX: profile.socialX || '',
    socialGithub: profile.socialGithub || '', socialTelegram: profile.socialTelegram || '',
    socialInstagram: profile.socialInstagram || '', bio: profile.bio || '',
    themeColor: profile.themeColor || '#D97706', followersCount: Number(profile.followersCount || 0),
    followingCount: Number(profile.followingCount || 0), isVerified: !!profile.isVerified,
    verificationColor: profile.verificationColor || '#2196F3', isAuthor: !!profile.isAuthor,
    creatorPage: profile.creatorPage || null,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

/** Master-admin repair: mirror every claimed handle into the public-profile collection. */
export async function backfillPublicProfilesForAllUsers(): Promise<{ scanned: number; mirrored: number; skipped: number }> {
  const current = auth.currentUser;
  if (!current || !checkIsAdmin(current.email)) throw new Error('Master administrator access required.');
  const snap = await getDocs(collection(db, 'users'));
  let mirrored = 0; let skipped = 0;
  for (const d of snap.docs) {
    const data = d.data() as CommunityUser;
    if (!data.username) { skipped++; continue; }
    try { await upsertPublicProfile({ ...data, uid: d.id } as CommunityUser); mirrored++; }
    catch (error) { skipped++; console.warn('Public profile backfill failed for', d.id, error); }
  }
  return { scanned: snap.size, mirrored, skipped };
}

export async function createCommunityProfile(data: Omit<CommunityUser, 'createdAt' | 'updatedAt' | 'followersCount' | 'followingCount'>) {
  if (!auth.currentUser) throw new Error("Must be logged in");
  const uid = auth.currentUser.uid;
  const username = validateUsername(data.username);
  if (username.length < 3) throw new Error('Username must be at least 3 characters.');

  const usernameRef = doc(db, 'usernames', username);
  const userRef = doc(db, 'users', uid);
  try {
    const existingSnap = await getDoc(userRef);
    if (existingSnap.exists()) {
      const existing = existingSnap.data() as any;
      if (String(existing.username || '')) {
        if (existing.username === username) return existing as CommunityUser;
        throw new Error('This account already has a handle. Edit it from Profile Settings.');
      }
      // First-time claim: preserve the auto-created Google profile and atomically
      // reserve the requested handle.
      await runTransaction(db, async tx => {
        const [userSnap, handleSnap] = await Promise.all([tx.get(userRef), tx.get(usernameRef)]);
        if (!userSnap.exists()) throw new Error('Profile not found.');
        const current: any = userSnap.data();
        if (String(current.username || '')) throw new Error('This account already has a handle.');
        if (handleSnap.exists() && handleSnap.data()?.uid !== uid) throw new Error('Username is already taken. Please choose another.');
        tx.set(usernameRef, { uid }, { merge: false });
        tx.update(userRef, { username, updatedAt: serverTimestamp(), bio: data.bio || current.bio || 'Software builder & writer', themeColor: data.themeColor || current.themeColor || '#D97706' });
      });
      const resolved = await getCommunityProfile(uid);
      if (!resolved) throw new Error('Unable to claim your handle.');
      await upsertPublicProfile(resolved);
      try { await ensureFollowingAuthor(uid, resolved.username); } catch (err) { console.warn('Failed to auto-follow @krishsarkar:', err); }
      return resolved;
    }

    const profile = await runTransaction(db, async tx => {
      const handleSnap = await tx.get(usernameRef);
      if (handleSnap.exists() && handleSnap.data()?.uid !== uid) throw new Error('Username is already taken. Please choose another.');
      const userData: any = {
        ...data, uid, username,
        role: data.role || '', isAuthor: !!data.isAuthor, isVerified: !!data.isVerified,
        verificationColor: data.verificationColor || '#2196F3', followersCount: 0, followingCount: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      };
      tx.set(usernameRef, { uid });
      tx.set(userRef, userData);
      return userData as CommunityUser;
    });
    const resolved = await getCommunityProfile(uid) || profile;
    await upsertPublicProfile(resolved as CommunityUser);
    if (username !== 'krishsarkar') {
      try { await ensureFollowingAuthor(uid, username); } catch (err) { console.warn('Failed to auto-follow @krishsarkar:', err); }
    }
    return resolved as CommunityUser;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${uid}`);
    throw error;
  }
}

export async function updateCommunityProfile(uid: string, data: Partial<CommunityUser>) {
  const p = `users/${uid}`;
  try {
    if (typeof uid !== 'string' || !uid.trim() || uid.length > 128 || uid.includes('/')) throw new Error('Invalid profile ID.');
    const current = auth.currentUser;
    if (!current) throw new Error('You must be signed in to edit your profile.');

    // Most profile edits are self-edits and do not require a read before the write.
    // Avoiding the pre-read/second read materially reduces Firestore quota pressure.
    const isSelfEdit = current.uid === uid;
    let existingProfile: CommunityUser | null = null;
    if (!isSelfEdit) {
      existingProfile = await getCommunityProfile(uid);
      const adminMayManageCanonicalAuthor = checkIsAdmin(current.email) && existingProfile?.username?.toLowerCase() === 'krishsarkar';
      if (!adminMayManageCanonicalAuthor) throw new Error('You can only edit your own profile.');
    }

    const clean: any = { ...data };
    const hasUsernameChange = Object.prototype.hasOwnProperty.call(clean, 'username');
    const requestedUsername = hasUsernameChange
      ? validateUsername(String(clean.username || ''))
      : (existingProfile?.username || '');
    delete clean.uid;
    delete clean.username;
    delete clean.createdAt;
    delete clean.email;
    delete clean.followersCount;
    delete clean.followingCount;
    delete clean.isBlocked;
    delete clean.isVerified;
    delete clean.verificationColor;
    delete clean.isAuthor;
    delete clean.role;
    delete clean.platformRole;
    clean.updatedAt = serverTimestamp();

    const userRef = doc(db, 'users', uid);
    const currentUsername = existingProfile?.username || '';

    // Fast path for a normal self-edit without a handle change: update the canonical
    // profile and its public projection in one batch, with no preliminary Firestore read.
    if (isSelfEdit && !hasUsernameChange) {
      const batch = writeBatch(db);
      batch.update(userRef, { ...clean });
      const publicUsername = String(data.username || '').trim().toLowerCase();
      if (publicUsername) {
        const publicBase: any = {
          username: publicUsername,
          ...(Object.prototype.hasOwnProperty.call(clean, 'displayName') ? { displayName: clean.displayName } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'photoURL') ? { photoURL: clean.photoURL } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'coverImageUrl') ? { coverImageUrl: clean.coverImageUrl } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'websiteUrl') ? { websiteUrl: clean.websiteUrl } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'location') ? { location: clean.location } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'socialX') ? { socialX: clean.socialX } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'socialGithub') ? { socialGithub: clean.socialGithub } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'socialTelegram') ? { socialTelegram: clean.socialTelegram } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'socialInstagram') ? { socialInstagram: clean.socialInstagram } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'bio') ? { bio: clean.bio } : {}),
          ...(Object.prototype.hasOwnProperty.call(clean, 'themeColor') ? { themeColor: clean.themeColor } : {}),
          updatedAt: serverTimestamp(),
        };
        batch.set(doc(db, 'publicProfiles', publicUsername), publicBase, { merge: true });
      }
      await batch.commit();
      invalidateFirestoreDocument(userRef.path);

      const identityChanged = Object.prototype.hasOwnProperty.call(clean, 'displayName') || Object.prototype.hasOwnProperty.call(clean, 'photoURL');
      if (identityChanged) {
        try {
          await syncUserIdentityAcrossContent(uid, {
            displayName: String(clean.displayName || ''),
            photoURL: String(clean.photoURL || ''),
            username: publicUsername,
          });
        } catch (syncError) {
          console.warn('Identity propagation incomplete; canonical profile saved:', syncError);
        }
      }
      return;
    }

    // Handle changes and authorized admin edits still require the transactional path
    // because username reservation must remain atomic and collision-safe.
    await runTransaction(db, async tx => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists()) throw new Error('Profile not found.');
      const currentData: any = userSnap.data();
      const liveUsername = String(currentData.username || currentUsername || '');
      const nextUserData: any = { ...clean, username: requestedUsername };
      const effectiveDisplayName = nextUserData.displayName ?? currentData.displayName ?? 'User';
      const effectivePhotoURL = nextUserData.photoURL ?? currentData.photoURL ?? '';
      const effectiveCover = nextUserData.coverImageUrl ?? currentData.coverImageUrl ?? '';
      const effectiveWebsite = nextUserData.websiteUrl ?? currentData.websiteUrl ?? '';
      const effectiveLocation = nextUserData.location ?? currentData.location ?? '';
      const effectiveSocialX = nextUserData.socialX ?? currentData.socialX ?? '';
      const effectiveSocialGithub = nextUserData.socialGithub ?? currentData.socialGithub ?? '';
      const effectiveSocialTelegram = nextUserData.socialTelegram ?? currentData.socialTelegram ?? '';
      const effectiveSocialInstagram = nextUserData.socialInstagram ?? currentData.socialInstagram ?? '';
      const effectiveBio = nextUserData.bio ?? currentData.bio ?? '';
      const effectiveTheme = nextUserData.themeColor ?? currentData.themeColor ?? '#D97706';
      const effectiveFollowers = Number(currentData.followersCount || 0);
      const effectiveFollowing = Number(currentData.followingCount || 0);
      const makePublic = (handle: string) => ({
        username: handle,
        displayName: effectiveDisplayName,
        photoURL: effectivePhotoURL,
        coverImageUrl: effectiveCover,
        websiteUrl: effectiveWebsite,
        location: effectiveLocation,
        socialX: effectiveSocialX,
        socialGithub: effectiveSocialGithub,
        socialTelegram: effectiveSocialTelegram,
        socialInstagram: effectiveSocialInstagram,
        bio: effectiveBio,
        themeColor: effectiveTheme,
        followersCount: effectiveFollowers,
        followingCount: effectiveFollowing,
        isVerified: !!currentData.isVerified,
        verificationColor: currentData.verificationColor || '#2196F3',
        isAuthor: !!currentData.isAuthor,
        creatorPage: nextUserData.creatorPage ?? currentData.creatorPage ?? null,
        updatedAt: serverTimestamp(),
      });

      if (hasUsernameChange && requestedUsername !== liveUsername) {
        const newUsernameRef = requestedUsername ? doc(db, 'usernames', requestedUsername) : null;
        const oldUsernameRef = liveUsername ? doc(db, 'usernames', liveUsername) : null;
        const newSnap = newUsernameRef ? await tx.get(newUsernameRef) : null;
        const oldSnap = oldUsernameRef ? await tx.get(oldUsernameRef) : null;
        if (newSnap?.exists() && newSnap.data()?.uid !== uid) throw new Error('Username is already taken. Please choose another.');
        if (liveUsername && (!oldSnap?.exists() || oldSnap.data()?.uid !== uid)) throw new Error('Current handle reservation is missing. Contact an administrator.');
        if (requestedUsername) tx.set(newUsernameRef!, { uid }, { merge: false });
        if (oldUsernameRef && liveUsername !== requestedUsername) tx.delete(oldUsernameRef);
        if (oldUsernameRef && liveUsername !== requestedUsername) tx.delete(doc(db, 'publicProfiles', liveUsername));
        if (oldUsernameRef && liveUsername !== requestedUsername) tx.set(doc(db, 'handleAliases', liveUsername), { newUsername: requestedUsername, updatedAt: serverTimestamp() }, { merge: true });
        if (requestedUsername) tx.set(doc(db, 'publicProfiles', requestedUsername), makePublic(requestedUsername), { merge: true });
      } else if (requestedUsername) {
        tx.set(doc(db, 'publicProfiles', requestedUsername), makePublic(requestedUsername), { merge: true });
      }

      tx.update(userRef, nextUserData);
    });
    invalidateFirestoreDocument(userRef.path);

    // Propagate from the values already submitted instead of re-reading the user doc.
    // This avoids an extra billed Firestore read after every identity edit.
    const identityChanged = hasUsernameChange || Object.prototype.hasOwnProperty.call(clean, 'displayName') || Object.prototype.hasOwnProperty.call(clean, 'photoURL');
    if (identityChanged) {
      try {
        await syncUserIdentityAcrossContent(uid, {
          displayName: String(clean.displayName || existingProfile?.displayName || ''),
          photoURL: String(clean.photoURL || existingProfile?.photoURL || ''),
          username: requestedUsername,
          isVerified: !!existingProfile?.isVerified,
          verificationColor: existingProfile?.verificationColor || '#2196F3'
        });
      } catch (syncError) {
        console.warn('Identity propagation incomplete; canonical profile saved:', syncError);
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, p);
  }
}

/** Realtime public profile subscription. Every viewer receives profile edits without a refresh. */
export function subscribeCommunityProfile(uid: string, callback: (profile: CommunityUser | null) => void, onError?: (error: unknown) => void): () => void {
  if (!uid) { callback(null); return () => {}; }
  return onSnapshot(
    doc(db, 'users', uid),
    snap => callback(snap.exists() ? (mapDocDates(snap.data()) as CommunityUser) : null),
    error => {
      console.warn(`Realtime profile subscription failed for ${uid}:`, error);
      onError?.(error);
    }
  );
}

export function subscribePublicProfileByUsername(username: string, callback: (profile: CommunityUser | null) => void, onError?: (error: unknown) => void): () => void {
  const clean = normalizeUsername(username);
  if (!clean) { callback(null); return () => {}; }
  return onSnapshot(
    doc(db, 'publicProfiles', clean),
    async snap => {
      if (snap.exists()) {
        const publicProfile = mapDocDates(snap.data()) as CommunityUser;
        if (auth.currentUser) {
          const uid = await resolvePublicHandleUid(clean);
          if (uid) (publicProfile as any).uid = uid;
        }
        callback(publicProfile);
        return;
      }
      // Self-heal the authenticated owner's own profile when the public projection
      // is missing. This does not expose a private user document to other viewers.
      if (auth.currentUser) {
        try {
          const own = await getCommunityProfile(auth.currentUser.uid);
          if (own?.username && normalizeUsername(own.username) === clean) {
            try { await upsertPublicProfile(own); } catch (e) { console.warn('Public profile projection repair skipped:', e); }
            callback(own);
            return;
          }
        } catch (e) { console.warn('Own profile fallback failed:', e); }
      }
      callback(null);
    },
    error => {
      console.warn(`Realtime public profile subscription failed for @${clean}:`, error);
      onError?.(error);
    }
  );
}

export async function ensureFollowingAuthor(currentUserId: string, currentUsername?: string): Promise<boolean> {
  const author = await getProfileByUsername('krishsarkar');
  if (!author || author.uid === currentUserId) return false;
  const followingRef = doc(db, 'users', currentUserId, 'following', author.uid);
  const existing = await getDoc(followingRef);
  if (existing.exists()) return false;
  await followUser(currentUserId, author.uid, author.username, currentUsername || '');
  return true;
}

export async function followUser(currentUserId: string, targetUserId: string, targetUsername?: string, currentUsername?: string, _old1?: any, _old2?: any) {
  const batch = writeBatch(db);
  
  // 1. Add targetUserId to currentUserId's following subcollection
  if (targetUsername) {
    batch.set(doc(db, 'users', currentUserId, 'following', targetUserId), {
      uid: targetUserId,
      username: targetUsername,
      createdAt: serverTimestamp()
    });
  } else {
    batch.set(doc(db, 'users', currentUserId, 'following', targetUserId), {
      uid: targetUserId,
      createdAt: serverTimestamp()
    });
  }

  // 2. Add currentUserId to targetUserId's followers subcollection
  if (currentUsername) {
    batch.set(doc(db, 'users', targetUserId, 'followers', currentUserId), {
      uid: currentUserId,
      username: currentUsername,
      createdAt: serverTimestamp()
    });
  } else {
    batch.set(doc(db, 'users', targetUserId, 'followers', currentUserId), {
      uid: currentUserId,
      createdAt: serverTimestamp()
    });
  }

  // 3. Update currentUserId's followingCount atomically
  batch.update(doc(db, 'users', currentUserId), {
    followingCount: increment(1),
    updatedAt: serverTimestamp()
  });

  // 4. Update targetUserId's followersCount atomically
  batch.update(doc(db, 'users', targetUserId), {
    followersCount: increment(1),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
    try {
      const actor = await getCommunityProfile(currentUserId);
      if (actor) await createNotification(targetUserId, { type: 'follow', actorId: actor.uid, actorUsername: actor.username, actorName: actor.displayName, actorAvatar: actor.photoURL || '', message: 'followed you', targetType: 'profile', targetId: actor.username });
    } catch (notificationError) { console.warn('Follow notification failed:', notificationError); }
    void emitActivityEvent({ type: 'follow', targetId: targetUserId, targetType: 'user', source: 'profile-follow' }).catch(() => {});
    return true;
  } catch (error) {
    console.error("Error following user:", error);
    throw error;
  }
}

export async function unfollowUser(currentUserId: string, targetUserId: string, _old1?: any, _old2?: any) {
  const batch = writeBatch(db);
  
  // 1. Remove targetUserId from currentUserId's following subcollection
  batch.delete(doc(db, 'users', currentUserId, 'following', targetUserId));

  // 2. Remove currentUserId from targetUserId's followers subcollection
  batch.delete(doc(db, 'users', targetUserId, 'followers', currentUserId));

  // 3. Update currentUserId's followingCount atomically
  batch.update(doc(db, 'users', currentUserId), {
    followingCount: increment(-1),
    updatedAt: serverTimestamp()
  });

  // 4. Update targetUserId's followersCount atomically
  batch.update(doc(db, 'users', targetUserId), {
    followersCount: increment(-1),
    updatedAt: serverTimestamp()
  });

  try {
    await batch.commit();
    void emitActivityEvent({ type: 'unfollow', targetId: targetUserId, targetType: 'user', source: 'profile-follow' }).catch(() => {});
    return true;
  } catch (error) {
    console.error("Error unfollowing user:", error);
    throw error;
  }
}

export async function checkIsFollowing(currentUserId: string, targetUserId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'users', currentUserId, 'following', targetUserId));
    return snap.exists();
  } catch (error) {
    console.error("Error checking following status:", error);
    return false;
  }
}

function postDedupeKey(data: Partial<CommunityPost>) {
  const raw = `${data.authorId || ''}|${data.type || ''}|${String(data.title || '').trim().toLowerCase()}|${String(data.content || '').trim()}|${Math.floor(Date.now()/600000)}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function dedupeLegacyPosts(items: CommunityPost[]) {
  const seen = new Set<string>(); const signatures = new Set<string>();
  return items.filter(p => {
    if (seen.has(p.id)) return false; seen.add(p.id);
    const t = new Date(p.createdAt || 0).getTime();
    const sig = `${p.authorId}|${p.type}|${String(p.title || '').trim().toLowerCase()}|${String(p.content || '').trim()}|${Math.floor(t / 60000)}`;
    if (signatures.has(sig)) return false; signatures.add(sig); return true;
  });
}

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(v => v !== undefined).map(v => stripUndefined(v)) as unknown as T;
  if (value && typeof value === 'object') {
    if ('_methodName' in (value as any) || String((value as any).constructor?.name || '').includes('FieldValue')) return value;
    const out: any = {};
    Object.entries(value as any).forEach(([k, v]) => { if (v !== undefined) out[k] = stripUndefined(v as any); });
    return out as T;
  }
  return value;
}

export async function createPost(data: Omit<CommunityPost, 'id' | 'createdAt' | 'updatedAt' | 'upvotesCount' | 'downvotesCount' | 'commentsCount' | 'isFeatured'>) {
  if (!auth.currentUser || auth.currentUser.uid !== data.authorId) throw new Error('You must be signed in as the post author.');
  const cleanTitle = String(data.title || '').trim().slice(0, 256);
  const cleanContent = String(data.content || '').trim().slice(0, 100000);
  if (!cleanTitle || !cleanContent) throw new Error('Title and content are required.');
  const dedupeKey = postDedupeKey({ ...data, title: cleanTitle, content: cleanContent });
  try {
    const existingSnap = await getDocs(query(collection(db, 'posts'), where('dedupeKey', '==', dedupeKey), limit(5)));
    const existing = existingSnap.docs.find(d => d.data()?.authorId === data.authorId && d.data()?.type === data.type);
    if (existing) return { ...existing.data(), id: existing.id, _publishStatus: 'existing' } as CommunityPost & { _publishStatus?: string };
    const postId = generateId();
    const p = `posts/${postId}`;
    const now = new Date().toISOString();
    const normalizedMediaUrls = Array.from(new Set((Array.isArray((data as any).mediaUrls) ? (data as any).mediaUrls : []).map((v:any) => String(v).trim()).filter(Boolean))).slice(0, 6);
    const firstImage = normalizedMediaUrls.find((url:string) => /\.(jpe?g|png|webp|gif|avif|bmp|svg)(?:$|\?)/i.test(url));
    const postData = stripUndefined({
      ...data,
      mediaUrls: normalizedMediaUrls,
      coverImage: (data as any).coverImage || firstImage || undefined,
      title: cleanTitle,
      content: cleanContent,
      dedupeKey,
      platformRole: data.platformRole || (checkIsAdmin(auth.currentUser.email) ? 'master_admin' : 'member'),
      mentionedUsernames: extractMentions(`${cleanTitle} ${cleanContent}`),
      hashtags: extractHashtags(`${cleanTitle} ${cleanContent}`),
      upvotesCount: 0,
      downvotesCount: 0,
      commentsCount: 0,
      repostsCount: 0,
      viewsCount: 0,
      isFeatured: false,
      origin: data.origin || 'community_post',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    await setDoc(doc(db, 'posts', postId), postData);
    const confirmed = await getDoc(doc(db, 'posts', postId));
    if (!confirmed.exists()) throw new Error('Post was not confirmed in the cloud. Please refresh before retrying.');
    const actor = await getCommunityProfile(auth.currentUser.uid);
    if (actor) { try { await notifyMentions(cleanTitle + ' ' + cleanContent, actor, 'post', postId); } catch (e) { console.warn('Post mention notifications failed:', e); } }
    return { ...confirmed.data(), id: confirmed.id, _publishStatus: 'created', createdAt: mapDocDates(confirmed.data()).createdAt || now, updatedAt: mapDocDates(confirmed.data()).updatedAt || now } as CommunityPost & { _publishStatus?: string };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, pForCreatePost(data));
    throw error;
  }
}
function pForCreatePost(data: Partial<CommunityPost>) { return `posts/${data.id || 'new'}`; }

export async function getPosts(type?: 'blog' | 'discussion'): Promise<CommunityPost[]> {
  const path = 'posts';
  try {
    const snap = await getDocs(query(collection(db, 'posts'), limit(500)));
    const items = snap.docs.map(d => ({ id: d.id, ...mapDocDates(d.data()) } as CommunityPost));
    const filtered = type ? items.filter(p => p.type === type) : items;
    return dedupeLegacyPosts(filtered).sort((a, b) => {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  } catch (error) {
    console.warn('Failed to load legacy posts:', error);
    throw error;
  }
}

export function subscribeCommunityPosts(type: 'blog' | 'discussion' | undefined, callback: (posts: CommunityPost[]) => void): () => void {
  let active = true;
  const q = query(collection(db, 'posts'), limit(500));
  const fallback = async () => {
    try {
      const items = await getPosts(type);
      if (active) callback(items);
    } catch (error) {
      console.warn('Legacy post fallback failed:', error);
      if (active) callback([]);
    }
  };
  const unsub = onSnapshot(q, (snap) => {
    const items = snap.docs.map(d => ({ id: d.id, ...mapDocDates(d.data()) } as CommunityPost));
    const filtered = type ? items.filter(p => p.type === type) : items;
    if (active) callback(dedupeLegacyPosts(filtered).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()));
  }, (error) => {
    console.warn('Legacy post realtime subscription failed:', error);
    void fallback();
  });
  return () => { active = false; unsub(); };
}



export async function getCarouselSlides(): Promise<CarouselSlide[]> {
  try {
    const snap = await getDocs(query(collection(db, 'carousel_slides'), orderBy('order', 'asc')));
    return snap.docs.map(d => ({ ...mapDocDates(d.data()), id: d.id } as CarouselSlide));
  } catch (error) {
    console.warn('Failed to load carousel slides:', error);
    return [];
  }
}

export function subscribeCarouselSlides(callback: (slides: CarouselSlide[]) => void): () => void {
  const q = query(collection(db, 'carousel_slides'), orderBy('order', 'asc'));
  return onSnapshot(q, snap => {
    callback(snap.docs.map(d => ({ ...mapDocDates(d.data()), id: d.id } as CarouselSlide)));
  }, error => {
    console.warn('Carousel realtime subscription failed:', error);
    callback([]);
  });
}

export async function addCarouselSlide(data: Omit<CarouselSlide, 'id' | 'createdAt' | 'updatedAt'>): Promise<CarouselSlide> {
  const id = generateId();
  const now = new Date().toISOString();
  await setDoc(doc(db, 'carousel_slides', id), stripUndefined({ ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  const confirmed = await getDoc(doc(db, 'carousel_slides', id));
  if (!confirmed.exists()) throw new Error('Carousel slide was not confirmed in the cloud.');
  return { ...mapDocDates(confirmed.data()), id: confirmed.id, createdAt: now, updatedAt: now } as CarouselSlide;
}

export async function updateCarouselSlide(id: string, data: Partial<CarouselSlide>): Promise<void> {
  await updateDoc(doc(db, 'carousel_slides', id), stripUndefined({ ...data, updatedAt: serverTimestamp() }));
}

export async function deleteCarouselSlide(id: string): Promise<void> {
  await deleteDoc(doc(db, 'carousel_slides', id));
}


export async function getUserPosts(userId: string, username?: string): Promise<CommunityPost[]> {
  const cleanUsername = username?.toLowerCase().trim();
  const byId = new Map<string, CommunityPost & { sourceType?: string; communityId?: string; communitySlug?: string }>();
  try {
    if (userId) {
      const authorSnap = await getDocs(query(collection(db, 'posts'), where('authorId', '==', userId)));
      authorSnap.docs.forEach(d => byId.set(`root:${d.id}`, { ...mapDocDates(d.data()), id: d.id, sourceType: 'root' } as any));
    }
    if (cleanUsername) {
      const authorUsernameSnap = await getDocs(query(collection(db, 'posts'), where('authorUsername', '==', cleanUsername), limit(500)));
      authorUsernameSnap.docs.forEach(d => byId.set(`root:${d.id}`, { ...mapDocDates(d.data()), id: d.id, sourceType: 'root' } as any));
    }
  } catch (error) {
    console.warn('Root profile post query failed:', error);
  }
  try {
    const communitiesSnap = await getDocs(query(collection(db, 'communities'), limit(200)));
    const results = await Promise.allSettled(communitiesSnap.docs.map(async cDoc => {
      const postsSnap = await getDocs(query(collection(db, 'communities', cDoc.id, 'posts'), limit(200)));
      return { cDoc, postsSnap };
    }));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { cDoc, postsSnap } = result.value;
      const cData: any = cDoc.data();
      for (const d of postsSnap.docs) {
        const data: any = d.data();
        if (data.authorId !== userId && !(cleanUsername && String(data.authorUsername || '').toLowerCase() === cleanUsername)) continue;
        byId.set(`community:${cDoc.id}:${d.id}`, {
          ...mapDocDates(data), id: d.id, sourceType: 'community', communityId: cDoc.id,
          communitySlug: cData.slug || cDoc.id
        } as any);
      }
    }
  } catch (error) {
    console.warn('Community profile post scan failed:', error);
  }
  return Array.from(byId.values()).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()) as CommunityPost[];
}

const postLocationCache = new Map<string, string | null>();

async function resolvePostLocation(postId: string): Promise<any | null> {
  if (!postId) return null;
  const cached = postLocationCache.get(postId);
  if (cached === 'root') return doc(db, 'posts', postId);
  if (cached && cached.startsWith('community:')) {
    const [, cid] = cached.split(':');
    return doc(db, 'communities', cid, 'posts', postId);
  }
  if (cached === null) return null;
  const rootRef = doc(db, 'posts', postId);
  const rootSnap = await getDoc(rootRef);
  if (rootSnap.exists()) { postLocationCache.set(postId, 'root'); return rootRef; }
  try {
    const communitiesSnap = await getDocs(query(collection(db, 'communities'), limit(300)));
    for (const c of communitiesSnap.docs) {
      const ref = doc(db, 'communities', c.id, 'posts', postId);
      const snap = await getDoc(ref);
      if (snap.exists()) { postLocationCache.set(postId, `community:${c.id}`); return ref; }
    }
  } catch (e) { console.warn('Community post location resolution failed:', e); }
  postLocationCache.set(postId, null);
  return null;
}

export async function getPost(postId: string): Promise<CommunityPost | null> {
  const path = `posts/${postId}`;
  try {
    const ref = await resolvePostLocation(postId);
    if (!ref) return null;
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data:any = snap.data();
    let live = data;
    if (data.authorUsername) {
      // Public post rendering must never read another user's private /users/{uid} document.
      // Firestore rules intentionally restrict that document to the owner/admin, which caused
      // repeated PERMISSION_DENIED errors on public pages. The publicProfiles projection is the
      // canonical public identity source.
      try {
        const cleanAuthor = normalizeUsername(String(data.authorUsername));
        const publicSnap = cleanAuthor ? await getDoc(doc(db, 'publicProfiles', cleanAuthor)) : null;
        if (publicSnap?.exists()) {
          const profile:any = mapDocDates(publicSnap.data());
          live = { ...data, authorUsername: profile.username || data.authorUsername || '', authorName: profile.displayName || data.authorName || '', authorAvatar: profile.photoURL || data.authorAvatar || '', isVerified: !!profile.isVerified, verificationColor: profile.verificationColor || data.verificationColor || '#2196F3' };
        }
      } catch (identityError) { console.warn('Post public author identity refresh failed:', identityError); }
    }
    return { ...live, id: snap.id, type: live.type || live.postType || 'discussion', communityId: live.communityId || (ref.path.startsWith('communities/') ? ref.path.split('/')[1] : undefined),
      commentsCount: Number(live.commentsCount || 0), upvotesCount: Number(live.upvotesCount ?? (live.score > 0 ? live.score : 0)), downvotesCount: Number(live.downvotesCount || 0), repostsCount: Number(live.repostsCount || 0), viewsCount: Number(live.viewsCount || 0),
      content: String(live.content || '') };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
}

export async function markPostAsMainArticleSource(postId: string, articleSlug: string): Promise<void> {
  await updateDoc(doc(db, 'posts', postId), { promotedToArticleSlug: articleSlug, promotedAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

export async function updatePost(postId: string, data: Partial<CommunityPost>) {
  const p = `posts/${postId}`;
  try {
    const patch: any = stripUndefined({ ...data, updatedAt: serverTimestamp() });
    const isContentEdit = typeof data.title === 'string' || typeof data.content === 'string';
    if (isContentEdit) patch.editedAt = serverTimestamp();
    if (isContentEdit) {
      const current = await getPost(postId);
      const title = typeof data.title === 'string' ? data.title : (current?.title || '');
      const content = typeof data.content === 'string' ? data.content : (current?.content || '');
      patch.mentionedUsernames = extractMentions(`${title} ${content}`);
      patch.hashtags = extractHashtags(`${title} ${content}`);
      if (current?.type === 'blog' && (((current as any).promotedToArticleSlug) || (current as any).mainPublicationStatus === 'published')) {
        patch.editReviewStatus = 'pending';
        patch.editReviewRequestedAt = serverTimestamp();
        patch.editReviewedAt = null;
        patch.editReviewedBy = null;
      }
    }
    const postRef = await resolvePostLocation(postId);
    if (!postRef) throw new Error('Post no longer exists.');
    await updateDoc(postRef, patch);
    const confirmed = await getDoc(postRef);
    if (!confirmed.exists()) throw new Error('Your edit was not confirmed in Firebase. Please refresh and try again.');
    // Public creator edits remain canonical in the source post. Published main articles
    // are hydrated from this source, so edits appear on the main site immediately with
    // EDITED + PENDING REVIEW until a master admin approves the change.
    return { ...mapDocDates(confirmed.data()), id: confirmed.id, type: (confirmed.data() as any).type || (confirmed.data() as any).postType || 'discussion', communityId: (confirmed.data() as any).communityId || (postRef.path.startsWith('communities/') ? postRef.path.split('/')[1] : undefined) } as CommunityPost;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, p);
    throw error;
  }
}

export async function voteRootPoll(postId: string, userId: string, optionIndex: number): Promise<void> {
  if (!auth.currentUser || auth.currentUser.uid !== userId) throw new Error('Authentication required.');
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7) throw new Error('Invalid poll option.');
  const postRef = await resolvePostLocation(postId);
  if (!postRef) throw new Error('Post not found.');
  if (postRef.path.split('/')[0] !== 'posts') throw new Error('Use the community poll flow for this poll.');
  const voteRef = doc(postRef, 'pollVotes', userId);
  const [postSnap, existing] = await Promise.all([getDoc(postRef), getDoc(voteRef)]);
  if (!postSnap.exists()) throw new Error('Post not found.');
  const data = postSnap.data() as any;
  if (data.type !== 'discussion' || !data.poll?.options?.[optionIndex]) throw new Error('Poll not found.');
  const batch = writeBatch(db);
  if (existing.exists()) {
    const old = Number(existing.data()?.optionIndex);
    if (old === optionIndex) return;
    batch.update(postRef, { [`poll.votes.${old}`]: increment(-1), [`poll.votes.${optionIndex}`]: increment(1), updatedAt: serverTimestamp() });
    batch.update(voteRef, { optionIndex, updatedAt: serverTimestamp() });
  } else {
    batch.set(voteRef, { uid: userId, optionIndex, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    batch.update(postRef, { [`poll.votes.${optionIndex}`]: increment(1), updatedAt: serverTimestamp() });
  }
  await batch.commit();
}

export async function getRootPollVote(postId: string, userId?: string): Promise<number|null> {
  if (!userId) return null;
  const postRef = doc(db, 'posts', postId);
  const snap = await getDoc(doc(postRef, 'pollVotes', userId));
  return snap.exists() && Number.isInteger(Number(snap.data()?.optionIndex)) ? Number(snap.data()?.optionIndex) : null;
}

export function subscribeCommunityComments(postId: string, callback: (comments: CommunityComment[]) => void): () => void {
  let unsub: (() => void) | null = null;
  let active = true;
  void resolvePostLocation(postId).then(ref => {
    if (!active) return;
    if (!ref) { callback([]); return; }
    const q = query(collection(ref, 'comments'), orderBy('createdAt', 'asc'));
    unsub = onSnapshot(q, snap => callback(snap.docs.map(d => ({ ...d.data(), id: d.id } as CommunityComment))), () => callback([]));
  }).catch(() => callback([]));
  return () => { active = false; unsub?.(); };
}

export async function getComments(postId: string): Promise<CommunityComment[]> {
  const p = `posts/${postId}/comments`;
  try {
    const postRef = await resolvePostLocation(postId);
    if (!postRef) return [];
    const q = query(collection(postRef, 'comments'), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ ...d.data(), id: d.id } as CommunityComment));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, p);
    return [];
  }
}

export async function addComment(postId: string, currentCommentsCount: number | any, data: Omit<CommunityComment, 'id' | 'postId' | 'createdAt' | 'updatedAt'>) {
  const commentId = generateId();
  const p = `posts/${postId}/comments/${commentId}`;
  try {
    const now = new Date().toISOString();
    const commentData = { ...data, postId, mentionedUsernames: extractMentions(data.content), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const postRef = await resolvePostLocation(postId);
    if (!postRef) throw new Error('Post no longer exists.');
    const batch = writeBatch(db);
    batch.set(doc(postRef, 'comments', commentId), commentData);
    batch.update(postRef, { commentsCount: increment(1), updatedAt: serverTimestamp() });
    
    await batch.commit();
    const actor = await getCommunityProfile(auth.currentUser?.uid || commentData.authorId);
    if (actor) {
      try {
        const target = await getPost(postId);
        if (target?.authorId) await createNotification(target.authorId, { type: commentData.parentId ? 'reply' : 'comment', actorId: actor.uid, actorUsername: actor.username, actorName: actor.displayName, actorAvatar: actor.photoURL || '', message: commentData.parentId ? 'replied to your comment' : 'commented on your post', targetType: 'post', targetId: postId });
        if (commentData.parentId) {
          try { const parent = await getDoc(doc(postRef, 'comments', commentData.parentId)); if (parent.exists()) await createNotification(parent.data().authorId, { type:'reply', actorId:actor.uid, actorUsername:actor.username, actorName:actor.displayName, actorAvatar:actor.photoURL || '', message:'replied to your comment', targetType:'comment', targetId:commentData.parentId }); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
        }
        await notifyMentions(commentData.content, actor, 'comment', commentId);
      } catch (e) { console.warn('Comment notifications failed:', e); }
    }
    return { ...commentData, id: commentId, createdAt: now, updatedAt: now } as CommunityComment;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, p);
    throw error;
  }
}

export async function toggleClap(postId: string, userId: string, currentClapsCount: number | any, isClapped: boolean) {
  const p = `posts/${postId}/claps/${userId}`;
  try {
    const batch = writeBatch(db);
    
    if (isClapped) {
      // Remove clap atomically
      batch.delete(doc(db, 'posts', postId, 'claps', userId));
      batch.update(doc(db, 'posts', postId), {
        clapsCount: increment(-1),
        updatedAt: serverTimestamp()
      });
    } else {
      // Add clap atomically
      batch.set(doc(db, 'posts', postId, 'claps', userId), {
        postId,
        userId,
        createdAt: serverTimestamp()
      });
      batch.update(doc(db, 'posts', postId), {
        clapsCount: increment(1),
        updatedAt: serverTimestamp()
      });
    }
    
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, p);
    throw error;
  }
}

export async function hasClapped(postId: string, userId: string): Promise<boolean> {
  const p = `posts/${postId}/claps/${userId}`;
  try {
    const snap = await getDoc(doc(db, 'posts', postId, 'claps', userId));
    return snap.exists();
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, p);
    return false;
  }
}

export async function deletePost(postId: string) {
  try {
    const postRef = await resolvePostLocation(postId);
    if (!postRef) return;
    const commentsSnap = await getDocs(collection(postRef, 'comments'));
    const votesSnap = await getDocs(collection(postRef, 'votes'));
    const clapsSnap = await getDocs(collection(postRef, 'claps'));
    const repostsSnap = await getDocs(collection(postRef, 'reposts'));

    const batch = writeBatch(db);
    commentsSnap.docs.forEach(d => batch.delete(d.ref));
    votesSnap.docs.forEach(d => batch.delete(d.ref));
    clapsSnap.docs.forEach(d => batch.delete(d.ref));
    repostsSnap.docs.forEach(d => batch.delete(d.ref));
    batch.delete(postRef);

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `posts/${postId}`);
    throw error;
  }
}

export async function updateComment(postId: string, commentId: string, content: string) {
  const u = auth.currentUser;
  if (!u) throw new Error('Authentication required.');
  const postRef = await resolvePostLocation(postId);
  if (!postRef) throw new Error('Post no longer exists.');
  const ref = doc(postRef, 'comments', commentId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Comment not found.');
  if (snap.data()?.authorId !== u.uid && !checkIsAdmin(u.email) && !(await isPlatformModerator(u.uid))) throw new Error('You can only edit your own reply.');
  const clean = String(content || '').trim();
  if (!clean || clean.length > 5000) throw new Error('Reply must contain 1–5000 characters.');
  await updateDoc(ref, { content: clean, mentionedUsernames: extractMentions(clean), editedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  const confirmed = await getDoc(ref);
  if (!confirmed.exists()) throw new Error('Reply edit was not confirmed in Firebase.');
  return { ...confirmed.data(), id: confirmed.id, createdAt: mapDocDates(confirmed.data()).createdAt, updatedAt: mapDocDates(confirmed.data()).updatedAt } as CommunityComment;
}

export async function toggleCommentReaction(postId: string, commentId: string): Promise<boolean> {
  const u = auth.currentUser; if (!u) throw new Error('Authentication required.');
  const postRef = await resolvePostLocation(postId); if (!postRef) throw new Error('Post no longer exists.');
  const commentRef = doc(postRef, 'comments', commentId);
  const reactionRef = doc(commentRef, 'reactions', u.uid);
  return runTransaction(db, async tx => {
    const commentSnap = await tx.get(commentRef); const reactionSnap = await tx.get(reactionRef);
    if (!commentSnap.exists()) throw new Error('Reply not found.');
    const active = !reactionSnap.exists(); const n = Math.max(0, Number(commentSnap.data()?.likeCount || 0) + (active ? 1 : -1));
    if (active) tx.set(reactionRef, { userId: u.uid, createdAt: serverTimestamp() }); else tx.delete(reactionRef);
    tx.update(commentRef, { likeCount: n, updatedAt: serverTimestamp() });
    return active;
  });
}

export async function isFollowingPost(postId: string, userId?: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const postRef = await resolvePostLocation(postId);
    if (!postRef) return false;
    return (await getDoc(doc(postRef, 'followers', userId))).exists();
  } catch { return false; }
}
export async function followPost(postId: string, userId: string): Promise<boolean> {
  const u = auth.currentUser; if (!u || u.uid !== userId) throw new Error('Authentication required.');
  const postRef = await resolvePostLocation(postId);
  const p = await getPost(postId);
  if (!postRef || !p) throw new Error('Discussion no longer exists.');
  const ref = doc(postRef, 'followers', userId);
  if ((await getDoc(ref)).exists()) return false;
  const actor = await getCommunityProfile(userId);
  await setDoc(ref, { userId, username: actor?.username || '', createdAt: serverTimestamp() });
  try { await createNotification(p.authorId, { type: 'follow', actorId: userId, actorUsername: actor?.username || '', actorName: u.displayName || 'User', actorAvatar: u.photoURL || '', message: 'followed your discussion', targetType: 'post', targetId: postId }); } catch (error) { console.warn('Follow notification skipped:', error); }
  void emitActivityEvent({type:'follow',targetId:postId,targetType:'post',source:'discussion'}).catch(()=>{});
  return true;
}
export async function unfollowPost(postId: string, userId: string): Promise<boolean> {
  const u = auth.currentUser; if (!u || u.uid !== userId) throw new Error('Authentication required.');
  const postRef = await resolvePostLocation(postId);
  if (!postRef) return false;
  const ref = doc(postRef, 'followers', userId);
  if (!(await getDoc(ref)).exists()) return false;
  await deleteDoc(ref); void emitActivityEvent({type:'unfollow',targetId:postId,targetType:'post',source:'discussion'}).catch(()=>{}); return true;
}
export async function markPostDiscussionRead(postId: string, userId?: string, commentId?: string) {
  if (!userId || auth.currentUser?.uid !== userId) return;
  await setDoc(doc(db, 'users', userId, 'discussionRead', postId), { postId, lastReadReplyId: commentId || '', readAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
}
export async function getPostDiscussionReadState(postId: string, userId?: string): Promise<{lastReadReplyId?: string; readAt?: string} | null> {
  if (!userId) return null; const s = await getDoc(doc(db, 'users', userId, 'discussionRead', postId)); if (!s.exists()) return null; return { lastReadReplyId: s.data()?.lastReadReplyId, readAt: mapDocDates(s.data()).readAt };
}

export async function deleteComment(postId: string, commentId: string) {
  try {
    const postRef = await resolvePostLocation(postId);
    if (!postRef) throw new Error('Post no longer exists.');
    const batch = writeBatch(db);
    batch.delete(doc(postRef, 'comments', commentId));
    batch.update(postRef, { commentsCount: increment(-1), updatedAt: serverTimestamp() });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `posts/${postId}/comments/${commentId}`);
    throw error;
  }
}

export async function adminChangeUserHandle(targetUid: string, requestedUsernameInput: string): Promise<CommunityUser> {
  const admin = auth.currentUser;
  if (!admin || !checkIsAdmin(admin.email)) throw new Error('Master administrator access required.');
  if (!targetUid || targetUid.includes('/')) throw new Error('Invalid target user ID.');
  const requestedUsername = validateUsername(requestedUsernameInput);
  const userRef = doc(db, 'users', targetUid);
  let updated: CommunityUser | null = null;
  await runTransaction(db, async tx => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists()) throw new Error('Target user profile not found.');
    const current: any = userSnap.data();
    const currentUsername = normalizeUsername(String(current.username || ''));
    if (currentUsername === requestedUsername) return;
    const newRef = requestedUsername ? doc(db, 'usernames', requestedUsername) : null;
    const oldRef = currentUsername ? doc(db, 'usernames', currentUsername) : null;
    const newSnap = newRef ? await tx.get(newRef) : null;
    if (newSnap?.exists() && String(newSnap.data()?.uid || '') !== targetUid) throw new Error('Username is already taken. Please choose another.');
    if (requestedUsername) tx.set(newRef!, { uid: targetUid }, { merge: false });
    if (oldRef && currentUsername !== requestedUsername) {
      const oldSnap = await tx.get(oldRef);
      if (oldSnap.exists() && String(oldSnap.data()?.uid || '') === targetUid) tx.delete(oldRef);
      tx.delete(doc(db, 'publicProfiles', currentUsername));
      tx.set(doc(db, 'handleAliases', currentUsername), { newUsername: requestedUsername, updatedAt: serverTimestamp() }, { merge: true });
    }
    if (requestedUsername) {
      const publicData = {
        username: requestedUsername, displayName: current.displayName || 'User', photoURL: current.photoURL || '',
        coverImageUrl: current.coverImageUrl || '', websiteUrl: current.websiteUrl || '', location: current.location || '',
        socialX: current.socialX || '', socialGithub: current.socialGithub || '', socialTelegram: current.socialTelegram || '',
        socialInstagram: current.socialInstagram || '', bio: current.bio || '', themeColor: current.themeColor || '#D97706',
        followersCount: Number(current.followersCount || 0), followingCount: Number(current.followingCount || 0),
        isVerified: !!current.isVerified, verificationColor: current.verificationColor || '#2196F3',
        isAuthor: !!current.isAuthor, creatorPage: current.creatorPage || null, updatedAt: serverTimestamp()
      };
      tx.set(doc(db, 'publicProfiles', requestedUsername), publicData, { merge: true });
    }
    tx.update(userRef, { username: requestedUsername, updatedAt: serverTimestamp() });
    updated = { ...current, uid: targetUid, username: requestedUsername };
  });
  if (!updated) {
    const latest = await getCommunityProfile(targetUid);
    if (!latest) throw new Error('Profile update could not be confirmed.');
    updated = latest;
  }
  try {
    await syncUserIdentityAcrossContent(targetUid, {
      displayName: updated.displayName || '', photoURL: updated.photoURL || '', username: updated.username || '',
      isVerified: !!updated.isVerified, verificationColor: updated.verificationColor || '#2196F3'
    });
  } catch (error) {
    console.warn('Admin handle propagation incomplete; canonical profile is saved:', error);
  }
  try { await upsertPublicProfile(updated); } catch (error) { console.warn('Admin public profile refresh skipped:', error); }
  return updated;
}

export async function setUserVerificationByUsername(usernameInput: string, isVerified: boolean, verificationColor: string): Promise<CommunityUser> {
  const admin = auth.currentUser;
  if (!admin || !admin.email) throw new Error('You must be signed in as an admin.');
  const cleanUsername = usernameInput.replace(/^@/, '').trim().toLowerCase();
  if (!cleanUsername) throw new Error('Enter a valid @handle.');
  const profile = await getProfileByUsername(cleanUsername);
  if (!profile) throw new Error(`No user found for @${cleanUsername}.`);
  const color = /^#[0-9a-fA-F]{6}$/.test(verificationColor) ? verificationColor : '#2196F3';

  // Update the canonical profile first, then denormalized author fields used by
  // feeds/comments/articles so the badge is visible without per-card reads.
  await updateDoc(doc(db, 'users', profile.uid), {
    isVerified,
    verificationColor: color,
    updatedAt: serverTimestamp()
  });

  const writes: Array<{ref: any; data: any}> = [];
  const postsSnap = await getDocs(query(collection(db, 'posts'), where('authorId', '==', profile.uid)));
  postsSnap.docs.forEach(d => writes.push({ref: d.ref, data: {isVerified, verificationColor: color, updatedAt: serverTimestamp()}}));

  // Main articles also denormalize author verification so the badge is shown
  // immediately in article cards, article pages, and search results.
  const articlesSnap = await getDocs(collection(db, 'articles'));
  articlesSnap.docs.forEach(d => {
    const data = d.data();
    const articleAuthor = data.author || {};
    if (articleAuthor.uid === profile.uid || articleAuthor.username?.toLowerCase() === cleanUsername) {
      writes.push({ ref: d.ref, data: {
        author: { ...articleAuthor, isVerified, verificationColor: color },
        updatedAt: serverTimestamp()
      }});
    }
  });
  let commentsSnap;
  try {
    commentsSnap = await getDocs(query(collectionGroup(db, 'comments'), where('authorId', '==', profile.uid)));
  } catch (indexError) {
    console.warn('Comments author index unavailable during verification; using fallback scan:', indexError);
    const allComments = await getDocs(collectionGroup(db, 'comments'));
    commentsSnap = { docs: allComments.docs.filter(d => d.data()?.authorId === profile.uid) } as any;
  }
  commentsSnap.docs.forEach(d => writes.push({ref: d.ref, data: {isVerified, verificationColor: color, updatedAt: serverTimestamp()}}));
  for (let i = 0; i < writes.length; i += 450) {
    const batch = writeBatch(db);
    writes.slice(i, i + 450).forEach(w => batch.update(w.ref, w.data));
    await batch.commit();
  }

  return {...profile, isVerified, verificationColor: color, updatedAt: new Date().toISOString()};
}

export async function getUserVerificationByUsername(usernameInput: string): Promise<Pick<CommunityUser, 'isVerified'|'verificationColor'> | null> {
  const profile = await getProfileByUsername(usernameInput.replace(/^@/, '').trim().toLowerCase());
  if (!profile) return null;
  return { isVerified: !!profile.isVerified, verificationColor: profile.verificationColor || '#2196F3' };
}

export async function blockUser(uid: string, isBlocked: boolean) {
  try {
    await updateDoc(doc(db, 'users', uid), { isBlocked });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
    throw error;
  }
}

export async function toggleVote(postId: string, userId: string, currentUpvotes: number, currentDownvotes: number, voteType: 'up' | 'down', currentVote: 'up' | 'down' | null) {
  void currentUpvotes; void currentDownvotes; void currentVote;
  const p = `posts/${postId}/votes/${userId}`;
  try {
    if (!userId || auth.currentUser?.uid !== userId) throw new Error('Authentication required.');
    const postRef = await resolvePostLocation(postId);
    if (!postRef) throw new Error('Post no longer exists.');
    let nextVote: 'up' | 'down' | null = null;
    let nextUpvotes = 0;
    let nextDownvotes = 0;
    await runTransaction(db, async tx => {
      const postSnap = await tx.get(postRef);
      const voteRef = doc(postRef, 'votes', userId);
      const voteSnap = await tx.get(voteRef);
      if (!postSnap.exists()) throw new Error('Post no longer exists.');
      const existingVote = voteSnap.exists() ? String(voteSnap.data()?.type || '') as 'up' | 'down' : null;
      const up = Math.max(0, Number(postSnap.data()?.upvotesCount ?? postSnap.data()?.score ?? 0));
      const down = Math.max(0, Number(postSnap.data()?.downvotesCount || 0));
      nextUpvotes = up; nextDownvotes = down;
      if (existingVote === voteType) {
        tx.delete(voteRef);
        if (existingVote === 'up') nextUpvotes = Math.max(0, up - 1);
        else nextDownvotes = Math.max(0, down - 1);
        nextVote = null;
        if (existingVote === 'up') tx.delete(doc(db, 'users', userId, 'upvotes', postId));
      } else {
        tx.set(voteRef, { postId, userId, uid: userId, type: voteType, createdAt: voteSnap.exists() ? (voteSnap.data()?.createdAt || serverTimestamp()) : serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
        if (existingVote === 'up') nextUpvotes = Math.max(0, up - 1);
        if (existingVote === 'down') nextDownvotes = Math.max(0, down - 1);
        if (voteType === 'up') {
          nextUpvotes += 1;
          tx.set(doc(db, 'users', userId, 'upvotes', postId), { postId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
        } else {
          nextDownvotes += 1;
          tx.delete(doc(db, 'users', userId, 'upvotes', postId));
        }
        nextVote = voteType;
      }
      tx.update(postRef, { upvotesCount: nextUpvotes, downvotesCount: nextDownvotes, updatedAt: serverTimestamp() });
    });
    if (nextVote === 'up') {
      try { const post = await getPost(postId); const actor = await getCommunityProfile(userId); if (post && actor) await createNotification(post.authorId, { type: 'upvote', actorId: actor.uid, actorUsername: actor.username, actorName: actor.displayName, actorAvatar: actor.photoURL || '', message: 'upvoted your post', targetType: 'post', targetId: postId }); } catch (notificationError) { console.warn('Upvote notification failed:', notificationError); }
    }
    return { vote: nextVote, upvotesCount: nextUpvotes, downvotesCount: nextDownvotes };
  } catch (error) { handleFirestoreError(error, OperationType.WRITE, p); throw error; }
}

export async function getUserVote(postId: string, userId: string): Promise<'up' | 'down' | null> {
  const p = `posts/${postId}/votes/${userId}`;
  try {
    const postRef = await resolvePostLocation(postId);
    if (!postRef) return null;
    const snap = await getDoc(doc(postRef, 'votes', userId));
    return snap.exists() ? (snap.data()?.type as 'up' | 'down') : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, p);
    return null;
  }
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const clean = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
  if (!clean || clean.length < 3 || clean.length > 32) return false;
  try {
    const snap = await getDoc(doc(db, 'usernames', clean));
    return !snap.exists();
  } catch (error) {
    console.error("Error checking username availability:", error);
    return false;
  }
}

export interface ProfileListEntry {
  uid: string;
  username: string;
  displayName: string;
  photoURL: string;
  isVerified?: boolean;
  verificationColor?: string;
}

async function getProfileList(userId: string, relation: 'followers' | 'following'): Promise<ProfileListEntry[]> {
  const snap = await getDocs(collection(db, 'users', userId, relation));
  const entries = await Promise.all(snap.docs.map(async (d) => {
    const data = d.data() as any;
    const targetUid = data.uid || d.id;
    const profile = await getCommunityProfile(targetUid);
    if (profile) {
      if (!profile.username) return null;
      return {
        uid: profile.uid,
        username: profile.username,
        displayName: profile.displayName,
        photoURL: profile.photoURL || '',
        isVerified: !!profile.isVerified,
        verificationColor: profile.verificationColor || '#2196F3'
      };
    }
    if (!data.username) return null;
    return {
      uid: targetUid,
      username: data.username,
      displayName: data.displayName || data.username || targetUid,
      photoURL: data.photoURL || '',
      isVerified: !!data.isVerified,
      verificationColor: data.verificationColor || '#2196F3'
    };
  }));
  return entries.filter(Boolean).sort((a, b) => a!.username.localeCompare(b!.username)) as ProfileListEntry[];
}

export async function getUserFollowers(userId: string): Promise<ProfileListEntry[]> {
  return getProfileList(userId, 'followers');
}

export async function getUserFollowing(userId: string): Promise<ProfileListEntry[]> {
  return getProfileList(userId, 'following');
}

export async function getUserUpvotedPosts(userId: string): Promise<CommunityPost[]> {
  const snap = await getDocs(query(collection(db, 'users', userId, 'upvotes'), orderBy('createdAt', 'desc')));
  const posts = await Promise.all(snap.docs.map(d => getPost(d.id)));
  return posts.filter(Boolean) as CommunityPost[];
}

export async function getUserRepostedPosts(userId: string): Promise<CommunityPost[]> {
  const snap = await getDocs(query(collection(db, 'users', userId, 'reposts'), orderBy('createdAt', 'desc')));
  const posts = await Promise.all(snap.docs.map(d => getPost(d.id)));
  return posts.filter(Boolean) as CommunityPost[];
}

export async function syncUserIdentityAcrossContent(
  userId: string,
  profile: Partial<Pick<CommunityUser, 'displayName' | 'photoURL' | 'username' | 'isVerified' | 'verificationColor'>>
): Promise<{ posts: number; comments: number; communityPosts: number; communities: number; memberships: number; relationships: number; questions: number; answers: number; articles: number; messages: number; notifications: number; reports: number; topics: number; series: number; moderators: number; adminNotifications: number }> {
  if (!userId) throw new Error('Invalid user ID.');
  const identity: Record<string, any> = {
    authorName: profile.displayName || '',
    authorAvatar: profile.photoURL || '',
    authorUsername: profile.username || '',
    updatedAt: serverTimestamp()
  };
  if (profile.isVerified !== undefined) identity.isVerified = !!profile.isVerified;
  if (profile.verificationColor !== undefined) identity.verificationColor = profile.verificationColor || '#2196F3';

  const writes: Array<{ ref: any; data: any }> = [];
  const writePaths = new Set<string>();
  const pushWrite = (ref: any, data: any) => {
    const path = String(ref?.path || '');
    if (!path || writePaths.has(path)) return false;
    writePaths.add(path);
    writes.push({ ref, data });
    return true;
  };
  const counters = { posts:0, comments:0, communityPosts:0, communities:0, memberships:0, relationships:0, questions:0, answers:0, articles:0, messages:0, notifications:0, reports:0, topics:0, series:0, moderators:0, adminNotifications:0 };

  const collectByQuery = async (q: any, data: any, key: keyof typeof counters, filterRef?: (ref:any) => boolean) => {
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      if (filterRef && !filterRef(d.ref)) continue;
      if (pushWrite(d.ref, data)) counters[key] += 1;
    }
  };

  // Canonical root posts. Collection-group /posts below is filtered to nested
  // community paths so the same document is never scheduled twice.
  await collectByQuery(query(collection(db, 'posts'), where('authorId', '==', userId)), identity, 'posts');

  try {
    await collectByQuery(
      query(collectionGroup(db, 'posts'), where('authorId', '==', userId)),
      identity,
      'communityPosts',
      (ref:any) => String(ref.path).startsWith('communities/')
    );
  } catch (e) { console.warn('Community-post identity query failed:', e); }

  try {
    await collectByQuery(query(collectionGroup(db, 'comments'), where('authorId', '==', userId)), identity, 'comments');
  } catch (e) { console.warn('Comment identity query failed:', e); }
  await collectByQuery(query(collection(db, 'questions'), where('authorId', '==', userId)), identity, 'questions');
  try {
    await collectByQuery(query(collectionGroup(db, 'answers'), where('authorId', '==', userId)), identity, 'answers');
  } catch (e) { console.warn('Answer identity query failed:', e); }

  await collectByQuery(query(collection(db, 'communities'), where('ownerId', '==', userId)), {
    ownerUsername: profile.username || '', ownerName: profile.displayName || '', ownerAvatar: profile.photoURL || '', updatedAt: serverTimestamp()
  }, 'communities');

  try {
    await collectByQuery(query(collectionGroup(db, 'members'), where('uid', '==', userId)), {
      username: profile.username || '', updatedAt: serverTimestamp()
    }, 'memberships');
  } catch (e) { console.warn('Membership identity query failed:', e); }

  try {
    await collectByQuery(query(collectionGroup(db, 'following'), where('uid', '==', userId)), {
      username: profile.username || '', updatedAt: serverTimestamp()
    }, 'relationships');
  } catch (e) { console.warn('Following identity query failed:', e); }

  try { await collectByQuery(query(collection(db, 'topics'), where('createdBy', '==', userId)), { creatorUsername: profile.username || '', updatedAt: serverTimestamp() }, 'topics'); }
  catch (e) { console.warn('Topic identity query failed:', e); }
  try { await collectByQuery(query(collection(db, 'series'), where('ownerId', '==', userId)), { ownerUsername: profile.username || '', updatedAt: serverTimestamp() }, 'series'); }
  catch (e) { console.warn('Series identity query failed:', e); }

  try {
    await collectByQuery(query(collection(db, 'messages'), where('senderId', '==', userId)), {
      senderUsername: profile.username || '', senderName: profile.displayName || '', senderAvatar: profile.photoURL || '', updatedAt: serverTimestamp()
    }, 'messages');
    await collectByQuery(query(collection(db, 'messages'), where('recipientId', '==', userId)), {
      recipientUsername: profile.username || '', recipientName: profile.displayName || '', recipientAvatar: profile.photoURL || '', updatedAt: serverTimestamp()
    }, 'messages');
  } catch (e) { console.warn('Message identity query failed:', e); }

  // Notification documents are recipient-private. The notification UI resolves the
  // current actor profile by actorId instead of rewriting every recipient's inbox.
  try {
    await collectByQuery(query(collection(db, 'reports'), where('reporterId', '==', userId)), {
      reporterUsername: profile.username || '', updatedAt: serverTimestamp()
    }, 'reports');
  } catch (e) { console.warn('Report identity query failed:', e); }

  try {
    const moderatorRef = doc(db, 'siteModerators', userId);
    const moderatorSnap = await getDoc(moderatorRef);
    if (moderatorSnap.exists() && pushWrite(moderatorRef, {
      username: profile.username || '', displayName: profile.displayName || '', updatedAt: serverTimestamp()
    })) counters.moderators = 1;
  } catch (e) { console.warn('Moderator identity query failed:', e); }

  // Main-publication articles use a nested author object. Never overwrite verification
  // metadata when this invocation is only a display-name/avatar change.
  try {
    const articles = await getDocs(collection(db, 'articles'));
    for (const d of articles.docs) {
      const data:any = d.data();
      const a:any = data?.author || {};
      const topAuthorId = data?.authorId || '';
      if (a.uid !== userId && topAuthorId !== userId) continue;
      const authorPatch:any = {
        ...a,
        uid: userId,
        username: profile.username || '',
        name: profile.displayName || '',
        avatar: profile.photoURL || ''
      };
      if (profile.isVerified !== undefined) authorPatch.isVerified = !!profile.isVerified;
      if (profile.verificationColor !== undefined) authorPatch.verificationColor = profile.verificationColor || '#2196F3';
      const articlePatch:any = {
        author: authorPatch,
        authorUsername: profile.username || '',
        authorName: profile.displayName || '',
        authorAvatar: profile.photoURL || '',
        ...(profile.isVerified !== undefined ? { isVerified: !!profile.isVerified } : {}),
        ...(profile.verificationColor !== undefined ? { verificationColor: profile.verificationColor || '#2196F3' } : {}),
        updatedAt: serverTimestamp()
      };
      if (data?.republishedBy?.uid === userId) {
        articlePatch.republishedBy = { ...data.republishedBy, uid:userId, username:profile.username || '', name:profile.displayName || '', avatar:profile.photoURL || '' };
      }
      if (pushWrite(d.ref, articlePatch)) counters.articles += 1;
    }
  } catch (e) { console.warn('Article identity scan failed:', e); }

  // Public profile is the read-side canonical identity for unauthenticated/profile surfaces.
  // Refresh it on avatar/name changes so the next lookup cannot resurrect an older snapshot.
  const publicUsername = String(profile.username || '').trim().toLowerCase();
  if (publicUsername) {
    try {
      const publicRef = doc(db, 'publicProfiles', publicUsername);
      const publicSnap = await getDoc(publicRef);
      if (publicSnap.exists()) {
        await setDoc(publicRef, {
          username: publicUsername,
          displayName: profile.displayName || publicSnap.data()?.displayName || '',
          photoURL: profile.photoURL || publicSnap.data()?.photoURL || '',
          ...(profile.isVerified !== undefined ? { isVerified: !!profile.isVerified } : {}),
          ...(profile.verificationColor !== undefined ? { verificationColor: profile.verificationColor || '#2196F3' } : {}),
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
    } catch (e) { console.warn('Public profile identity sync failed:', e); }
  }

  // Keep the publication-level author identity canonical, but only when a trusted
  // admin is performing the sync. Normal profile edits must never gain write access
  // to siteConfig/global.
  if (checkIsAdmin(auth.currentUser?.email) && auth.currentUser?.uid) {
    try {
      const siteRef = doc(db, 'siteConfig', 'global');
      const siteSnap = await getDoc(siteRef);
      if (siteSnap.exists()) {
        const site:any = siteSnap.data();
        const siteUid = String(site.authorProfileUid || '');
        const siteUsername = String(site.authorProfileUsername || '').toLowerCase();
        const nextUsername = String(profile.username || '').toLowerCase();
        if (siteUid === userId || (siteUsername === 'krishsarkar' && nextUsername === 'krishsarkar')) {
          pushWrite(siteRef, {
            authorProfileUid: userId,
            authorProfileUsername: profile.username || 'krishsarkar',
            authorName: profile.displayName || '',
            authorAvatarUrl: profile.photoURL || '',
            updatedAt: serverTimestamp()
          });
        }
      }
    } catch (e) { console.warn('SiteConfig author identity sync failed:', e); }
  }

  for (let i=0; i<writes.length; i+=450) {
    const batch = writeBatch(db);
    writes.slice(i, i+450).forEach(w => batch.update(w.ref, w.data));
    await batch.commit();
  }

  return counters;
}

export async function getUserComments(userId: string, username?: string): Promise<Array<{ id: string; content: string; createdAt: string; postId?: string; articleSlug?: string; authorName: string }>> {
  const comments = new Map<string, any>();
  if (userId) {
    try {
      const snap = await getDocs(query(collectionGroup(db, 'comments'), where('authorId', '==', userId)));
      snap.docs.forEach(d => comments.set(d.id, d));
    } catch (indexError) {
      console.warn('Comments author index unavailable for profile:', indexError);
    }
  }
  const cleanUsername = username?.trim().toLowerCase();
  if (cleanUsername) {
    try {
      const snap = await getDocs(query(collectionGroup(db, 'comments'), where('authorUsername', '==', cleanUsername), limit(500)));
      snap.docs.forEach(d => comments.set(d.id, d));
    } catch (usernameError) {
      console.warn('Comments username query failed for profile:', usernameError);
    }
  }
  return Array.from(comments.values()).map(d => {
    const data = d.data();
    const path = d.ref.path.split('/');
    const postId = path[0] === 'posts' ? path[1] : undefined;
    const articleSlug = path[0] === 'articles' ? path[1] : undefined;
    return { id: d.id, content: data.content || '', createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()), postId, articleSlug, authorName: data.authorName || 'Architect' };
  }).sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function toggleRepost(postId: string, userId: string, isReposted: boolean): Promise<boolean> {
  void isReposted;
  if (!userId || auth.currentUser?.uid !== userId) throw new Error('Authentication required.');
  const postRef = await resolvePostLocation(postId);
  if (!postRef) throw new Error('Post no longer exists.');
  let next = false;
  await runTransaction(db, async tx => {
    const postSnap = await tx.get(postRef);
    const repostRef = doc(db, 'users', userId, 'reposts', postId);
    const reverseRef = doc(postRef, 'reposts', userId);
    const personal = await tx.get(repostRef);
    const reverse = await tx.get(reverseRef);
    if (!postSnap.exists()) throw new Error('Post no longer exists.');
    const currently = personal.exists() || reverse.exists();
    next = !currently;
    const count = Math.max(0, Number(postSnap.data()?.repostsCount || 0));
    if (currently) {
      tx.delete(repostRef); tx.delete(reverseRef);
      tx.update(postRef, { repostsCount: Math.max(0, count - 1), updatedAt: serverTimestamp() });
    } else {
      const post = postSnap.data() as any;
      tx.set(repostRef, { postId, title: post.title || '', authorId: post.authorId || '', authorUsername: post.authorUsername || '', createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      tx.set(reverseRef, { userId, createdAt: serverTimestamp() });
      tx.update(postRef, { repostsCount: count + 1, updatedAt: serverTimestamp() });
    }
  });
  if (next) { try { const actor = await getCommunityProfile(userId); const target = await getPost(postId); if (actor && target) await createNotification(target.authorId, { type: 'repost', actorId: actor.uid, actorUsername: actor.username, actorName: actor.displayName, actorAvatar: actor.photoURL || '', message: 'reposted your post', targetType: 'post', targetId: postId }); } catch (e) { console.warn('Repost notification failed:', e); } }
  return next;
}

export async function quoteRepost(postId: string, user: CommunityUser, quoteText: string): Promise<CommunityPost> {
  const original = await getPost(postId);
  if (!original) throw new Error('Original post no longer exists.');
  const text = quoteText.trim();
  if (!text) throw new Error('Add a comment before publishing the quote.');

  // Publishing the quote is the primary operation. Repost bookkeeping is
  // intentionally best-effort so a stale/older Firestore rule cannot prevent
  // the quote itself from being published.
  const created = await createPost({
    type: original.type, title: original.title, content: original.content,
    authorId: user.uid, authorUsername: user.username, authorName: user.displayName,
    authorAvatar: user.photoURL || '', isVerified: !!user.isVerified,
    verificationColor: user.verificationColor || '#2196F3',
    mediaUrls: original.mediaUrls || [], hashtags: original.hashtags || [],
    quoteText: text, quotedPostId: postId
  });

  try {
    await toggleRepost(postId, user.uid, false);
  } catch (e) {
    console.warn('Quote published but repost bookkeeping failed:', e);
  }
  return created;
}

export async function getUserRepostStatus(postId: string, userId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', userId, 'reposts', postId));
  return snap.exists();
}

export async function getUserSaves(userId: string): Promise<UserSavedItem[]> {
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'saves'));
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        itemId: data.itemId,
        itemType: data.itemType,
        title: data.title,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || new Date().toISOString()),
        collectionId: data.collectionId || undefined,
        collectionName: data.collectionName || undefined
      };
    });
  } catch (error) {
    console.warn("Could not fetch user saves from Firestore:", error);
    return [];
  }
}

/** Realtime per-account save subscription. Cloud state is authoritative for signed-in users. */
export function subscribeUserSaves(userId: string, callback: (items: UserSavedItem[]) => void, onError?: (error: unknown) => void): () => void {
  if (!userId) { callback([]); return () => {}; }
  return onSnapshot(collection(db, 'users', userId, 'saves'), snap => {
    callback(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        itemId: String(data.itemId || ''),
        itemType: data.itemType,
        title: String(data.title || ''),
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || ''),
        collectionId: data.collectionId || undefined,
        collectionName: data.collectionName || undefined,
      } as UserSavedItem;
    }));
  }, error => {
    console.warn(`Realtime saves subscription failed for ${userId}:`, error);
    onError?.(error);
  });
}

export interface ReadingProgress {
  articleSlug: string;
  articleTitle: string;
}

/** Stores one private, per-account resume point. */
export async function saveReadingProgress(userId: string, article: { slug: string; title: string }): Promise<void> {
  await setDoc(doc(db, 'reading_progress', userId), {
    articleSlug: article.slug,
    articleTitle: article.title,
    updatedAt: serverTimestamp(),
  });
}

export async function getReadingProgress(userId: string): Promise<ReadingProgress | null> {
  const snapshot = await getDoc(doc(db, 'reading_progress', userId));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return typeof data.articleSlug === 'string' && typeof data.articleTitle === 'string'
    ? { articleSlug: data.articleSlug, articleTitle: data.articleTitle }
    : null;
}

export async function toggleUserSaveInCloud(
  userId: string,
  itemId: string,
  itemType: 'article' | 'post',
  isCurrentlySaved: boolean,
  title?: string,
  collectionId?: string,
  collectionName?: string
): Promise<boolean> {
  const saveId = `${itemType}_${itemId}`;
  const saveRef = doc(db, 'users', userId, 'saves', saveId);
  try {
    if (isCurrentlySaved) {
      await deleteDoc(saveRef);
      void emitActivityEvent({ type: 'unsave', targetId: itemId, targetType: itemType, source: 'save' }).catch(() => {});
      return false;
    } else {
      await setDoc(saveRef, {
        itemId,
        itemType,
        title: title || '',
        collectionId: collectionId || 'general',
        collectionName: collectionName || 'General',
        createdAt: serverTimestamp()
      });
      void emitActivityEvent({ type: 'save', targetId: itemId, targetType: itemType, source: 'save' }).catch(() => {});
      return true;
    }
  } catch (error) {
    console.error("Error toggling save in cloud:", error);
    throw error;
  }
}

export async function getBookmarkCollections(userId: string): Promise<BookmarkCollection[]> {
  const snap = await getDocs(collection(db, 'users', userId, 'collections'));
  return snap.docs.map(d => ({ id: d.id, ...mapDocDates(d.data()) } as BookmarkCollection))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function createBookmarkCollection(userId: string, name: string, description = ''): Promise<BookmarkCollection> {
  const clean = name.trim().slice(0, 50);
  if (!clean) throw new Error('Collection name is required.');
  const id = generateId();
  const now = new Date().toISOString();
  await setDoc(doc(db, 'users', userId, 'collections', id), {
    name: clean, description: description.trim().slice(0, 160), createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  return { id, name: clean, description: description.trim().slice(0, 160), createdAt: now, updatedAt: now };
}

export async function updateSavedItemCollection(userId: string, itemId: string, itemType: 'article' | 'post', collectionId: string, collectionName: string): Promise<void> {
  const saveId = `${itemType}_${itemId}`;
  await updateDoc(doc(db, 'users', userId, 'saves', saveId), { collectionId, collectionName });
}

export async function deleteBookmarkCollection(userId: string, collectionId: string): Promise<void> {
  if (collectionId === 'general') return;
  const saves = await getDocs(query(collection(db, 'users', userId, 'saves'), where('collectionId', '==', collectionId)));
  const batch = writeBatch(db);
  saves.docs.forEach(d => batch.update(d.ref, { collectionId: 'general', collectionName: 'General' }));
  batch.delete(doc(db, 'users', userId, 'collections', collectionId));
  await batch.commit();
}

export async function getArticleLikeStatus(slug: string, userId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'articleLikes', slug, 'likes', userId));
    return snap.exists();
  } catch (error) {
    console.warn("Error checking article like status:", error);
    return false;
  }
}

export async function toggleArticleLike(slug: string, userId: string, isCurrentlyLiked: boolean): Promise<boolean> {
  const likeRef = doc(db, 'articleLikes', slug, 'likes', userId);
  try {
    if (isCurrentlyLiked) {
      await deleteDoc(likeRef);
      return false;
    } else {
      await setDoc(likeRef, {
        slug,
        userId,
        createdAt: serverTimestamp()
      });
      return true;
    }
  } catch (error) {
    console.error("Error toggling article like:", error);
    throw error;
  }
}



function getStableVisitorId(): string {
  if (typeof window === 'undefined') return 'server';
  const KEY = 'offscrpt:visitor-id:v1';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const value = `${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(KEY, value);
    return value;
  } catch {
    return `ephemeral-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}
export async function recordCommunityPostView(postId:string, viewerId?:string):Promise<void>{
  if(!postId) return;
  const authenticated=Boolean(viewerId);
  const identity=viewerId||getStableVisitorId();
  const day=new Date().toISOString().slice(0,10);
  const safePost=encodeURIComponent(postId).slice(0,180);
  const safeIdentity=encodeURIComponent(identity).slice(0,220);
  const receiptId=`${safePost}_${safeIdentity}_${day}`;
  const localKey=`offscrpt:post-view:${postId}:${day}`;
  let rootRef=doc(db,'posts',postId);
  try {
    let targetRef:any=rootRef;
    const direct=await getDoc(rootRef);
    if(!direct.exists()){
      const snap=await getDocs(query(collectionGroup(db,'posts'), where('__name__','==',postId), limit(20)));
      const match=snap.docs.find((d:any)=>d.id===postId);
      if(!match) return;
      targetRef=match.ref;
    }
    const receiptRef=doc(targetRef,'views',receiptId);
    if(!authenticated){
      try { if(localStorage.getItem(localKey)==='1') return; } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
      await setDoc(receiptRef,{postId,visitorId:identity,day,createdAt:serverTimestamp()},{merge:false});
      await runTransaction(db,async tx=>{
        const postSnap=await tx.get(targetRef);
        if(!postSnap.exists()) return;
        tx.update(targetRef,{viewsCount:Number(postSnap.data()?.viewsCount||0)+1,updatedAt:serverTimestamp()});
      });
      try { localStorage.setItem(localKey,'1'); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
      return;
    }
    await runTransaction(db,async tx=>{
      const [postSnap,receiptSnap]=await Promise.all([tx.get(targetRef),tx.get(receiptRef)]);
      if(!postSnap.exists() || receiptSnap.exists()) return;
      tx.set(receiptRef,{postId,userId:viewerId,day,createdAt:serverTimestamp()});
      tx.update(targetRef,{viewsCount:Number(postSnap.data()?.viewsCount||0)+1,updatedAt:serverTimestamp()});
    });
  } catch(e){ console.warn('Community post view tracking failed:',e); }
}
