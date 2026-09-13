import { emitActivityEvent } from './activity';
import { enqueueIndexSync } from './indexSync';
import { 
  collection, 
  collectionGroup,
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc,
  deleteDoc, 
  onSnapshot, 
  query, 
  where,
  orderBy, 
  serverTimestamp,
  Timestamp,
  writeBatch,
  limit,
  increment,
  runTransaction
} from 'firebase/firestore';
import { db, auth, checkIsAdmin } from './firebase';
import { writeAdminAudit } from './audit';
import { deletePost, getCommunityProfile, getProfileByUsername, getPost } from './community';
import { getModeratorPermissions } from './social';
import { resolveMasterAccess } from './masterControl';
import { Article, SiteConfig, BentoLink, ArticleComment, CommunityPost, NavigationItemConfig } from '../types';
import { INITIAL_ARTICLES } from '../data/articles';

export const DEFAULT_TOP_NAVIGATION: NavigationItemConfig[] = [
  { id: 'home', label: 'Home', page: 'home', visible: true },
  { id: 'blog', label: 'SCRPTS', page: 'blog', visible: true },
  { id: 'social', label: 'Community', page: 'social', visible: true },
  { id: 'saved', label: 'Saved', page: 'saved', visible: true },
  { id: 'notifications', label: 'Notifications', page: 'notifications', visible: true },
  { id: 'explore', label: 'Explore', page: 'explore', visible: true },
  { id: 'series', label: 'Series', page: 'series', visible: true },
];

export const DEFAULT_MENU_NAVIGATION: NavigationItemConfig[] = [
  { id: 'about', label: 'About', page: 'about', visible: true },
  { id: 'links', label: 'Links', page: 'links', visible: true },
  { id: 'contact', label: 'Contact', page: 'contact', visible: true },
];

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  logoImageUrl: "",
  logoPart1: "OFF",
  logoPart2: "SCRPT",
  tagline: "ARCHITECTURAL TECH PRESS // DISTRIBUTED SYSTEMS & LOCAL AI",
  heroHeadline: "BUILDING THE FUTURE OF THE WEB.",
  heroSubheadline: "Deep architectural breakdowns, systems design essays, and uncensored engineering dispatches from the front lines of distributed software.",
  heroBgColor: "#FFFFFF",
  manifestoText: "Software engineering is not about accumulating abstractions; it is about mastering control over complexity, performance, and user agency.",
  manifestoAuthor: "Krish Sarkar",
  authorName: "Krish",
  authorRole: "Founder & Systems Architect",
  authorAvatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=400&auto=format&fit=crop",
  aboutMeTitle: "SYSTEMS ARCHITECT // SOFTWARE CRAFTSMAN",
  topNavigation: DEFAULT_TOP_NAVIGATION,
  menuNavigation: DEFAULT_MENU_NAVIGATION,
  aboutMeBio: "I am a software engineer and systems architect specializing in high-performance web applications and distributed systems.\n\nOver the past decade, I have built infrastructure that scales to millions of users, designed resilient microservices, and obsessed over web performance metrics.",
  themePrimaryColor: "#FFD600",
  themeSecondaryColor: "#00E0FF",
  themeAccentColor: "#FF60B5",
  themeSuccessColor: "#00FF41",
  readingProgressPageColor: "#2563EB",
  readingProgressPersistentColor: "#FFD600",
  aiTheme: {
    primary: '#FF00E5',
    secondary: '#2457FF',
    accent: '#00E0FF',
    background: '#FFFFFF',
    surface: '#FFFFFF',
    border: '#000000',
    text: '#000000',
    mutedText: '#525252',
    buttonText: '#000000',
    hover: '#FFD600',
    active: '#2457FF',
    inputBackground: '#FFFFFF',
    inputBorder: '#000000',
    userMessage: '#FFFFFF',
    assistantMessage: '#FF00E5',
    source: '#E9E9E9',
    link: '#2457FF',
    icon: '#000000',
    header: '#FF00E5',
  },
  marqueeItems: [
    { id: 'marquee-1', text: 'BUILDING ON THE OPEN INTERNET' },
    { id: 'marquee-2', text: 'OFFSCRPT TECH PRESS' },
    { id: 'marquee-3', text: 'BUILD. LEARN. CREATE.' },
    { id: 'marquee-4', text: 'NEW DISPATCHES EVERY TUESDAY' },
    { id: 'marquee-5', text: 'NO FLUFF • REAL PRODUCTION CODE' },
    { id: 'marquee-6', text: 'DISTRIBUTED SYSTEMS & LOCAL AI' },
  ],
  marqueeSpeedSeconds: 25,
  marqueePauseOnHover: true,
  blogHeader: {
    eyebrow: 'THE DISPATCHES ARCHIVE',
    title: 'ENGINEERING & ARCHITECTURE',
    description: 'Rigorous, hands-on writing dissecting modern web technologies, AI agent architectures, distributed database internals, and developer productivity systems.',
    backgroundColor: '#D97706',
    textColor: '#000000',
    showEssayCount: true,
    essayCountLabel: 'ESSAYS PUBLISHED'
  },
  footerNavigationTitle: 'NAVIGATION',
  footerTopicsTitle: 'CURATED TOPICS',
  footerHubTitle: 'PUBLICATION HUB',
  footerNavigationLinks: [
    { id: 'footer-nav-home', label: 'Home', type: 'internal', target: 'home', visible: true },
    { id: 'footer-nav-blog', label: 'SCRPTS', type: 'internal', target: 'blog', visible: true },
    { id: 'footer-nav-explore', label: 'Explore', type: 'internal', target: 'explore', visible: true },
    { id: 'footer-nav-series', label: 'Series', type: 'internal', target: 'series', visible: true },
    { id: 'footer-nav-about', label: 'About Krish', type: 'internal', target: 'about', visible: true },
    { id: 'footer-nav-contact', label: 'Contact Desk', type: 'internal', target: 'contact', visible: true },
  ],
  footerHubLinks: [
    { id: 'footer-hub-rss', label: 'RSS / XML Feed', type: 'rss', target: 'rss', visible: true },
    { id: 'footer-hub-github', label: 'GitHub', type: 'external', target: 'https://github.com/krishficient', visible: true },
    { id: 'footer-hub-telegram', label: 'Telegram', type: 'external', target: 'https://t.me/krishficient', visible: true },
    { id: 'footer-hub-instagram', label: 'Instagram', type: 'external', target: 'https://instagram.com/krishficient', visible: true },
  ],
  footerTopicCategories: [],
  footerBottomRightText: 'HIGH DENSITY SPECIFICATION',
  footerNewsletterTitle: "RECEIVE DEEP TECHNICAL ESSAYS IN YOUR INBOX",
  footerNewsletterSubtitle: "Zero spam. Zero generic marketing. Only in-depth software architectural breakdowns, local AI research, and production post-mortems.",
  footerBrandStatement: "An independent technology publication engineered by Krish. Fusing Neo-Brutalism, Gumroad minimalism, and Medium-grade editorial craft for software builders worldwide.",
  contactTitle: "SECURE COMM CHANNEL",
  contactSubtitle: "For architectural consulting, secure protocol design, or technical inquiries.",
  contactEmail: "hello@krishficient.dev",
  contactTwitter: "@krishficient",
  contactGithub: "krishficient",
  contactTelegram: "@krishficient",
  contactInstagram: "@krishficient",
  contactWebsite: "https://offscrpt.vercel.app",
  contactX: "@krishficient",
  maintenanceMode: false,
  emergencyAdminLock: false,
  readOnlyMode: false,
  registrationsEnabled: true,
  commentsEnabled: true,
  postingEnabled: true,
  reactionsEnabled: true,
  followingEnabled: true,
  uploadsEnabled: true,
  maintenanceMessage: "OFFSCRPT is temporarily under maintenance.",
  communityEnabled: true,
  allowCommunityCreation: true,
  allowCommunityPosts: true,
  allowQuestions: true,
  allowTopics: true,
  allowDirectMessages: true,
  allowPublicBlogs: true,
  allowCommunityBlogs: true,
  allowCommunityDiscussions: true,
  showSocialAnnouncement: false,
  socialAnnouncement: "",
  socialAnnouncementLink: "",
  socialDefaultSort: 'new',
  customCategories: [],
  popupAnnouncement: { id: 'default-announcement', enabled: false, title: '', message: '', type: 'info', priority: 'normal', displayMode: 'popup', frequency: 'until_dismissed', audience: 'everyone', targetPage: 'all', linkLabel: '', linkTarget: '', actionLabel: '', actionTarget: '', dismissible: true },
  authorProfileUid: '',
  authorProfileUsername: 'krishsarkar'
};


function stripUndefinedDeep<T>(value:T):T {
  if (value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => stripUndefinedDeep(v)).filter(v => v !== undefined) as T;
  if (value && typeof value === 'object') {
    const obj:any = value as any;
    if (obj && typeof obj === 'object' && ('_methodName' in obj || obj?.constructor?.name?.includes('FieldValue'))) return value;
    const out:any = {};
    Object.entries(obj).forEach(([k,v]) => { if (v !== undefined) out[k] = stripUndefinedDeep(v as any); });
    return out as T;
  }
  return value;
}

export const DEFAULT_BENTO_LINKS: BentoLink[] = [
  {
    id: "bento-github",
    title: "GitHub Architecture Repos",
    url: "https://github.com",
    icon: "github",
    isFeatured: true,
    color: "#00E0FF",
    order: 1
  },
  {
    id: "bento-twitter",
    title: "Daily Engineering Dispatches on X",
    url: "https://x.com",
    icon: "twitter",
    isFeatured: true,
    color: "#FFD600",
    order: 2
  },
  {
    id: "bento-youtube",
    title: "System Architecture Deep-Dives",
    url: "https://youtube.com",
    icon: "youtube",
    isFeatured: false,
    color: "#FF60B5",
    order: 3
  },
  {
    id: "bento-podcast",
    title: "Local AI & Systems Engineering Podcast",
    url: "https://spotify.com",
    icon: "podcast",
    isFeatured: false,
    color: "#00FF41",
    order: 4
  },
  {
    id: "bento-newsletter",
    title: "Weekly High-Density Substack Dispatch",
    url: "https://substack.com",
    icon: "mail",
    isFeatured: true,
    color: "#FFD600",
    order: 5
  }
];

// ==========================================
// 1. SITE CONFIGURATION (CLOUD PERSISTENCE)
// ==========================================

export function subscribeSiteConfig(callback: (config: SiteConfig) => void): () => void {
  const configDocRef = doc(db, 'siteConfig', 'global');
  return onSnapshot(configDocRef, (snap) => {
    if (snap.exists()) {
      callback({ ...DEFAULT_SITE_CONFIG, ...(snap.data() as Partial<SiteConfig>) });
    } else {
      callback(DEFAULT_SITE_CONFIG);
    }
  }, (err) => {
    console.warn("Real-time site config listener failed, using defaults:", err);
    callback(DEFAULT_SITE_CONFIG);
  });
}

export async function getSiteConfig(): Promise<SiteConfig> {
  try {
    const snap = await getDoc(doc(db, 'siteConfig', 'global'));
    if (snap.exists()) {
      return { ...DEFAULT_SITE_CONFIG, ...(snap.data() as Partial<SiteConfig>) };
    }
  } catch (error) {
    console.warn("Failed to fetch site config from Firestore:", error);
  }
  return DEFAULT_SITE_CONFIG;
}

export async function saveSiteConfig(config: SiteConfig): Promise<void> {
  const configDocRef = doc(db, 'siteConfig', 'global');
  const beforeSnap = await getDoc(configDocRef).catch((error)=>{console.warn('Site config snapshot lookup failed:',error);return null});
  await setDoc(configDocRef, {
    ...config,
    updatedAt: serverTimestamp()
  }, { merge: true });
  if (await resolveMasterAccess(auth.currentUser)) { try { await writeAdminAudit('changed site config','siteConfig/global',beforeSnap?.exists?beforeSnap.data():null,config); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); } }
}


export async function createSiteConfigBackup(config: SiteConfig, label='Manual backup') {
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const id=`backup_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  await setDoc(doc(db,'siteConfigBackups',id),{label:label.trim().slice(0,120)||'Manual backup',snapshot:config,createdBy:admin.uid,createdByEmail:admin.email||'',createdAt:serverTimestamp()});
}

export async function getSiteConfigBackups():Promise<any[]> {
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const snap=await getDocs(query(collection(db,'siteConfigBackups'),limit(100)));
  return snap.docs.map(d=>({id:d.id,...d.data(),createdAt:(d.data() as any).createdAt?.toDate?.()?.toISOString?.() || String((d.data() as any).createdAt||'')})).sort((a:any,b:any)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime());
}

export async function restoreSiteConfigBackup(backupId:string):Promise<SiteConfig> {
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const snap=await getDoc(doc(db,'siteConfigBackups',backupId)); if(!snap.exists()) throw new Error('Backup not found.');
  const config=snap.data().snapshot as SiteConfig; await saveSiteConfig(config); return config;
}


export async function syncAdminAuthorProfile(author: {
  name: string;
  role: string;
  avatar: string;
  bio: string;
}): Promise<{ uid: string; username: string }> {
  const admin = auth.currentUser;
  if (!admin || !checkIsAdmin(admin.email)) throw new Error('Unauthorized: admin account required.');

  const username = 'krishsarkar';
  const usernameRef = doc(db, 'usernames', username);
  const usernameSnap = await getDoc(usernameRef);
  // The canonical author belongs to the existing @krishsarkar reservation.
  // Multiple trusted admin Google accounts may manage the same author profile.
  const uid = usernameSnap.exists() && usernameSnap.data()?.uid ? usernameSnap.data().uid : admin.uid;
  const userRef = doc(db, 'users', uid);
  const existingUser = await getDoc(userRef);
  const profileData: any = {
    uid, username,
    displayName: author.name || 'Krish Sarkar',
    photoURL: author.avatar || (existingUser.exists() ? String(existingUser.data()?.photoURL || '') : '') || admin.photoURL || '',
    bio: author.bio || '',
    themeColor: '#FFD600',
    role: author.role || 'Founder & Systems Architect',
    isAuthor: true,
    isVerified: existingUser.exists() ? !!existingUser.data()?.isVerified : true,
    verificationColor: existingUser.exists() ? (existingUser.data()?.verificationColor || '#2196F3') : '#2196F3',
    followersCount: existingUser.exists() ? (existingUser.data()?.followersCount || 0) : 0,
    followingCount: existingUser.exists() ? (existingUser.data()?.followingCount || 0) : 0,
    createdAt: existingUser.exists() ? existingUser.data()?.createdAt : serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  const batch = writeBatch(db);
  if (usernameSnap.exists()) {
    if (usernameSnap.data()?.uid !== uid) throw new Error('@krishsarkar reservation is inconsistent.');
    batch.update(usernameRef, { uid });
  } else {
    batch.set(usernameRef, { uid });
  }
  if (existingUser.exists()) batch.update(userRef, profileData);
  else batch.set(userRef, profileData);
  await batch.commit();

  try {
    await setDoc(doc(db, 'publicProfiles', username), {
      username,
      displayName: profileData.displayName,
      photoURL: profileData.photoURL,
      bio: profileData.bio,
      isVerified: !!profileData.isVerified,
      verificationColor: profileData.verificationColor || '#2196F3',
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (projectionError) {
    console.warn('Canonical public profile projection refresh failed:', projectionError);
  }

  // Canonical content propagation is centralized in the identity sync helper.
  // This keeps root posts, community posts, comments, answers, questions, articles,
  // messages and publication config on the same identity path.
  try {
    const { syncUserIdentityAcrossContent } = await import('./community');
    await syncUserIdentityAcrossContent(uid, {
      displayName: profileData.displayName,
      photoURL: profileData.photoURL,
      username,
      isVerified: existingUser.exists() ? existingUser.data()?.isVerified : true,
      verificationColor: existingUser.exists() ? existingUser.data()?.verificationColor : '#2196F3'
    });
  } catch (identityError) {
    console.warn('Canonical author saved but some denormalized identity snapshots could not be refreshed:', identityError);
  }

  // Keep Firebase Auth aligned when the canonical author is the current admin.
  if (admin.uid === uid && (author.avatar || author.name)) {
    try {
      const { updateProfile } = await import('firebase/auth');
      await updateProfile(admin, { displayName: profileData.displayName, photoURL: profileData.photoURL || null });
    } catch (authError) {
      console.warn('Canonical Firebase Auth author identity refresh failed:', authError);
    }
  }

  return { uid, username };
}

// ==========================================
// 2. BENTO LINKS (CLOUD PERSISTENCE)
// ==========================================

export function subscribeBentoLinks(callback: (links: BentoLink[]) => void): () => void {
  const bentoDocRef = doc(db, 'bento', 'global');
  return onSnapshot(bentoDocRef, (snap) => {
    if (snap.exists() && Array.isArray(snap.data().links)) {
      callback(snap.data().links as BentoLink[]);
    } else {
      callback(DEFAULT_BENTO_LINKS);
    }
  }, (err) => {
    console.warn("Real-time bento links listener failed, using defaults:", err);
    callback(DEFAULT_BENTO_LINKS);
  });
}

export async function getBentoLinks(): Promise<BentoLink[]> {
  try {
    const snap = await getDoc(doc(db, 'bento', 'global'));
    if (snap.exists() && Array.isArray(snap.data().links)) {
      return snap.data().links as BentoLink[];
    }
  } catch (error) {
    console.warn("Failed to fetch bento links from Firestore:", error);
  }
  return DEFAULT_BENTO_LINKS;
}

export async function saveBentoLinks(links: BentoLink[]): Promise<void> {
  const bentoDocRef = doc(db, 'bento', 'global');
  await setDoc(bentoDocRef, {
    links,
    updatedAt: serverTimestamp()
  });
}

// ==========================================
// 3. ARTICLES / EDITORIAL CMS CONTENT
// ==========================================

async function getDeletedSlugs(): Promise<Set<string>> {
  const deletedSet = new Set<string>();
  try {
    const snap = await getDocs(collection(db, 'deleted_articles'));
    snap.docs.forEach(d => deletedSet.add(d.id));
  } catch (e) {
    // ignore if rules or network issues
  }
  return deletedSet;
}


function normalizeArticleRecord(raw: any, fallbackId = ''): Article {
  const data = raw && typeof raw === 'object' ? raw : {};
  const fallbackAuthor = data.author && typeof data.author === 'object' ? data.author : {};
  const id = String(data.id || fallbackId || data.slug || '');
  const slug = String(data.slug || fallbackId || id);
  const rawContent = Array.isArray(data.content) ? data.content : (Array.isArray(data.contentBlocks) ? data.contentBlocks : []);
  const content = rawContent
    .filter((block: any) => block && typeof block === 'object')
    .map((block: any) => ({
      ...block,
      type: String(block.type || 'paragraph'),
      content: String(block.content ?? ''),
      items: Array.isArray(block.items) ? block.items.map((item: any) => String(item ?? '')).filter(Boolean) : [],
      codeBlock: block.codeBlock && typeof block.codeBlock === 'object' ? {
        ...block.codeBlock,
        code: String(block.codeBlock.code ?? ''),
        language: String(block.codeBlock.language ?? 'text'),
        filename: String(block.codeBlock.filename ?? ''),
      } : undefined,
      href: block.href != null ? String(block.href) : undefined,
      linkText: block.linkText != null ? String(block.linkText) : undefined,
      buttonText: block.buttonText != null ? String(block.buttonText) : undefined,
      imageUrl: block.imageUrl != null ? String(block.imageUrl) : undefined,
      imageAlt: block.imageAlt != null ? String(block.imageAlt) : undefined,
      imageCaption: block.imageCaption != null ? String(block.imageCaption) : undefined,
      imageHref: block.imageHref != null ? String(block.imageHref) : undefined,
      videoUrl: block.videoUrl != null ? String(block.videoUrl) : undefined,
      videoTitle: block.videoTitle != null ? String(block.videoTitle) : undefined,
      videoCaption: block.videoCaption != null ? String(block.videoCaption) : undefined,
      calloutTitle: block.calloutTitle != null ? String(block.calloutTitle) : undefined,
      quoteAuthor: block.quoteAuthor != null ? String(block.quoteAuthor) : undefined,
    }));
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag: any) => String(tag || '').trim()).filter(Boolean)
    : [];
  const author = {
    name: String(fallbackAuthor.name || data.authorName || 'OFFSCRPT'),
    role: String(fallbackAuthor.role || data.authorRole || 'Author'),
    avatar: String(fallbackAuthor.avatar || data.authorAvatar || ''),
    bio: String(fallbackAuthor.bio || ''),
    uid: fallbackAuthor.uid || data.authorId || undefined,
    username: fallbackAuthor.username || data.authorUsername || undefined,
    isVerified: Boolean(fallbackAuthor.isVerified ?? data.isVerified ?? false),
    verificationColor: fallbackAuthor.verificationColor || data.verificationColor || undefined,
  };
  return {
    ...data,
    id,
    slug,
    title: String(data.title || 'Untitled Dispatch'),
    excerpt: String(data.excerpt || ''),
    coverImage: String(data.coverImage || ''),
    coverImageAlt: String(data.coverImageAlt || data.title || ''),
    category: String(data.category || 'Technology'),
    tags,
    publishedAt: String(data.publishedAt || data.createdAt || ''),
    readingTimeMinutes: Math.max(1, Number(data.readingTimeMinutes || 1)),
    author,
    content,
  } as Article;
}

function mergeArticlesWithInitial(cloudArticles: Article[], deletedSlugs: Set<string>): Article[] {
  // Production must remain cloud-backed. The local archive is only useful during
  // development when explicitly opted in, never as a silent production data source.
  if (import.meta.env.PROD) return cloudArticles.filter(a => !deletedSlugs.has(a.slug));
  const cloudSlugs = new Set(cloudArticles.map(a => a.slug));
  const fallbackOnly = INITIAL_ARTICLES.filter(a => !cloudSlugs.has(a.slug) && !deletedSlugs.has(a.slug));
  return [...cloudArticles, ...fallbackOnly];
}

async function hydrateArticleOriginalAuthor(article: Article): Promise<Article> {
  if (!article.sourcePostId || article.origin !== 'community_blog') return article;
  const fallback:any = article.originalAuthor || article.author;
  try {
    let post:any = null;
    if ((article as any).sourceCommunityId) {
      post = await getDoc(doc(db, 'communities', (article as any).sourceCommunityId, 'posts', article.sourcePostId));
      post = post.exists() ? { ...post.data(), id: post.id } : null;
    } else {
      post = await getPost(article.sourcePostId);
    }
    if (!post?.authorId) return article;
    let profile:any = null;
    try {
      profile = post.authorUsername
        ? await getProfileByUsername(String(post.authorUsername))
        : (auth.currentUser?.uid === String(post.authorId) ? await getCommunityProfile(post.authorId) : null);
    } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    const originalAuthor = {
      ...fallback,
      uid: post.authorId,
      username: profile?.username || post.authorUsername || fallback?.username,
      name: profile?.displayName || post.authorName || fallback?.name,
      avatar: profile?.photoURL || post.authorAvatar || fallback?.avatar,
      bio: profile?.bio || fallback?.bio || '',
      role: profile?.isVerified ? 'Verified Creator' : (fallback?.role || 'Creator'),
      isVerified: !!(profile?.isVerified ?? post.isVerified ?? fallback?.isVerified),
      verificationColor: profile?.verificationColor || post.verificationColor || fallback?.verificationColor
    };
    return { ...article, author: originalAuthor as any, originalAuthor };
  } catch (e) {
    console.warn('Could not hydrate original article creator:', e);
    return article;
  }
}

async function hydrateArticleAuthors(articles: Article[]): Promise<Article[]> {
  const candidates = articles.filter(a => !!a.sourcePostId && a.origin === 'community_blog');
  if (!candidates.length) return articles;
  const hydrated = await Promise.all(candidates.map(hydrateArticleOriginalAuthor));
  const bySlug = new Map(hydrated.map(a => [a.slug, a]));
  return articles.map(a => bySlug.get(a.slug) || a);
}

async function hydratePublishedSourcePosts(articles: Article[]): Promise<Article[]> {
  const candidates = articles.filter(a => !!a.sourcePostId && a.origin === 'community_blog' && a.mainPublicationStatus !== 'unpublished');
  if (!candidates.length) return articles;
  const hydrated = await Promise.all(candidates.map(async article => {
    try {
      let post:any = null;
      if ((article as any).sourceCommunityId) {
        const snap = await getDoc(doc(db,'communities',(article as any).sourceCommunityId,'posts',article.sourcePostId!));
        post = snap.exists() ? { ...snap.data(), id: snap.id } : null;
      } else {
        post = await getPost(article.sourcePostId!);
      }
      if (!post || post.mainPublicationStatus === 'unpublished') return article;
      const contentBlocks = Array.isArray(post.contentBlocks) && post.contentBlocks.length ? post.contentBlocks : article.content;
      return {
        ...article,
        title: post.title || article.title,
        excerpt: post.excerpt || article.excerpt,
        coverImage: post.coverImage || article.coverImage,
        coverImageAlt: post.coverImageAlt || article.coverImageAlt,
        coverImageCaption: post.coverImageCaption || article.coverImageCaption,
        category: post.category || article.category,
        tags: Array.isArray(post.tags) ? post.tags : article.tags,
        readingTimeMinutes: post.readingTimeMinutes || article.readingTimeMinutes,
        seriesId: post.seriesId || article.seriesId,
        seriesName: post.seriesName || article.seriesName,
        seriesOrder: post.seriesOrder || article.seriesOrder,
        content: contentBlocks,
        editedAt: post.editedAt || article.editedAt,
        editReviewStatus: post.editReviewStatus || article.editReviewStatus,
        editReviewRequestedAt: post.editReviewRequestedAt || article.editReviewRequestedAt,
        editReviewedAt: post.editReviewedAt || article.editReviewedAt,
        editReviewedBy: post.editReviewedBy || article.editReviewedBy,
        originalAuthor: article.originalAuthor,
        author: article.author,
      } as Article;
    } catch { return article; }
  }));
  const bySlug = new Map(hydrated.map(a => [a.slug, a]));
  return articles.map(a => bySlug.get(a.slug) || a);
}

export function subscribeArticles(callback: (articles: Article[]) => void): () => void {
  const articlesRef = collection(db, 'articles');
  let sourceUnsubs: Array<()=>void> = [];
  let disposed = false;
  let latestCloudArticles: Article[] = [];
  const emit = async () => {
    if(disposed) return;
    const deletedSlugs = await getDeletedSlugs();
    const visible = latestCloudArticles.filter(a => !deletedSlugs.has(a.slug) && a.isPublished !== false);
    const hydrated = await hydrateArticleAuthors(visible).then(hydratePublishedSourcePosts);
    if(!disposed) callback(mergeArticlesWithInitial(hydrated, deletedSlugs).map(a => normalizeArticleRecord(a, a.id || a.slug)));
  };
  const resetSourceListeners = (articles:Article[]) => {
    sourceUnsubs.forEach(u=>u()); sourceUnsubs=[];
    articles.filter(a=>!!a.sourcePostId && a.origin==='community_blog' && a.mainPublicationStatus!=='unpublished').forEach(article=>{
      const ref = (article as any).sourceCommunityId
        ? doc(db,'communities',(article as any).sourceCommunityId,'posts',article.sourcePostId!)
        : doc(db,'posts',article.sourcePostId!);
      const unsub=onSnapshot(ref,()=>{ void emit(); },()=>{});
      sourceUnsubs.push(unsub);
    });
  };
  const unsubArticles=onSnapshot(articlesRef, async snap=>{
    if(disposed) return;
    latestCloudArticles=snap.docs.map(d=>normalizeArticleRecord(d.data(), d.id));
    latestCloudArticles.sort((a,b)=>new Date(b.publishedAt||0).getTime()-new Date(a.publishedAt||0).getTime());
    resetSourceListeners(latestCloudArticles);
    await emit();
  }, err=>{
    console.warn('Real-time articles subscription failed:',err);
    // Never replace live CMS data with a synthetic/local archive in production.
    if(!disposed) callback(import.meta.env.DEV ? INITIAL_ARTICLES : []);
  });
  return ()=>{ disposed=true; unsubArticles(); sourceUnsubs.forEach(u=>u()); sourceUnsubs=[]; };
}

export async function fetchAllArticlesForAdmin(): Promise<Article[]> {
  if (!(await resolveMasterAccess())) throw new Error('Master admin access required.');
  const snap = await getDocs(collection(db, 'articles'));
  const articles = snap.docs.map(d => normalizeArticleRecord(d.data(), d.id));
  const hydrated = await hydrateArticleAuthors(articles);
  return hydrated.sort((a,b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
}

export async function fetchArticles(): Promise<{ articles: Article[]; source: 'firestore' | 'fallback' }> {
  try {
    const deletedSlugs = await getDeletedSlugs();
    const snap = await getDocs(collection(db, 'articles'));
    if (!snap.empty) {
      const cloudArticles = snap.docs.map(d => {
        const data = d.data();
        return normalizeArticleRecord(data, d.id);
      }).filter(a => !deletedSlugs.has(a.slug) && a.isPublished !== false);
      cloudArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      const hydrated = await hydratePublishedSourcePosts(await hydrateArticleAuthors(cloudArticles));
      return {
        articles: mergeArticlesWithInitial(hydrated, deletedSlugs),
        source: 'firestore'
      };
    }
  } catch (error) {
    console.warn("Could not fetch articles from Firestore, using initial dataset:", error);
  }
  return {
    articles: import.meta.env.DEV ? INITIAL_ARTICLES : [],
    source: import.meta.env.DEV ? 'fallback' : 'firestore'
  };
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
export async function recordArticleView(slug:string, viewerId?:string):Promise<void>{
  if(!slug) return;
  const identity = viewerId || getStableVisitorId();
  const day = new Date().toISOString().slice(0,10);
  const articleRef = doc(db,'articles',slug);
  const localKey = `offscrpt:view:${slug}:${day}`;
  try { if(localStorage.getItem(localKey)==='1') return; } catch { /* local persistence is optional */ }

  if(viewerId){
    const receiptRef = doc(db,'users',viewerId,'articleViewReceipts',`${encodeURIComponent(slug).slice(0,180)}_${day}`);
    try{
      await runTransaction(db, async (tx)=>{
        const receiptSnap=await tx.get(receiptRef);
        if(receiptSnap.exists()) return;
        const articleSnap=await tx.get(articleRef);
        if(!articleSnap.exists()) return;
        const current=Number(articleSnap.data()?.viewsCount||0);
        tx.set(receiptRef,{slug,day,userId:viewerId,createdAt:serverTimestamp()},{merge:true});
        tx.update(articleRef,{viewsCount:current+1,updatedAt:serverTimestamp()});
      });
      try { localStorage.setItem(localKey,'1'); } catch { /* optional */ }
    }catch(e){ console.warn('Article view tracking failed:',e); }
    return;
  }

  const visitorId = identity;
  const receiptId = `${encodeURIComponent(slug).slice(0,180)}_${encodeURIComponent(visitorId).slice(0,220)}_${day}`;
  const receiptRef = doc(db,'articleViews',receiptId);
  try{
    await setDoc(receiptRef,{slug,visitorId,day,createdAt:serverTimestamp()},{merge:false});
    await runTransaction(db,async(tx)=>{const articleSnap=await tx.get(articleRef);if(!articleSnap.exists())return;const current=Number(articleSnap.data()?.viewsCount||0);tx.update(articleRef,{viewsCount:current+1,updatedAt:serverTimestamp()});});
    try{localStorage.setItem(localKey,'1');}catch{/* optional */}
  }catch(e){ console.warn('Anonymous article view tracking failed:',e); }
  void emitActivityEvent({ type:'content_view', targetId:slug, targetType:'article', source:'article' }).catch(()=>{});
}

export async function getArticleViewCount(slug:string):Promise<number>{
  if(!slug) return 0;
  try { const snap = await getDoc(doc(db, 'articles', slug)); return Number(snap.data()?.viewsCount || 0); }
  catch { return 0; }
}

export const ARTICLE_REACTIONS = ['like','useful','insightful','interesting'] as const;
export type ArticleReaction = typeof ARTICLE_REACTIONS[number];
export async function setArticleReaction(slug:string,userId:string,reaction:ArticleReaction|null):Promise<void>{
  if(!userId || !slug) throw new Error('Sign in required.');
  const ref=doc(db,'articles',slug,'reactions',userId);
  const indexRef=doc(db,'users',userId,'reactionIndex',encodeURIComponent(slug).slice(0, 1500));
  if(reaction){
    await Promise.all([
      setDoc(ref,{userId,reaction,updatedAt:serverTimestamp()},{merge:true}),
      setDoc(indexRef,{itemId:slug,slug,articleSlug:slug,reaction,updatedAt:serverTimestamp()},{merge:true}),
    ]);
  } else {
    const old=await getDoc(ref);
    if(old.exists()) await deleteDoc(ref);
    try { await deleteDoc(indexRef); } catch { /* best-effort cleanup for legacy accounts */ }
  }
  void emitActivityEvent({ type: reaction ? 'like' : 'unlike', targetId: slug, targetType:'article', metadata:{ reaction: reaction || '' } }).catch(()=>{});
}

export async function getArticleReaction(slug:string,userId:string):Promise<ArticleReaction|null>{
  if(!userId) return null; const s=await getDoc(doc(db,'articles',slug,'reactions',userId)); return s.exists()?(s.data()?.reaction||null):null;
}
export async function getSeriesArticles(seriesId:string):Promise<Article[]>{
  if(!seriesId) return [];
  const snap=await getDocs(query(collection(db,'articles'),where('seriesId','==',seriesId),limit(100)));
  return snap.docs.map(d=>normalizeArticleRecord(d.data(), d.id)).sort((a:any,b:any)=>(a.seriesOrder||0)-(b.seriesOrder||0));
}
export type ArticleRevisionAction = 'initial' | 'auto-save' | 'manual' | 'before-restore' | 'restored';

export interface ArticleRevision {
  id: string;
  slug: string;
  article: Article;
  action: ArticleRevisionAction;
  createdBy: string;
  createdByEmail?: string;
  createdByName?: string;
  createdAt?: any;
}

export async function createArticleRevision(article:Article, action:ArticleRevisionAction='manual'):Promise<string|undefined>{
  const admin=auth.currentUser;
  if(!admin || !checkIsAdmin(admin.email) || !article?.slug) return;
  const id=`${article.slug}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  await setDoc(doc(db,'articleRevisions',id),{
    article: stripUndefinedDeep(article),
    slug: article.slug,
    title: article.title || '',
    action,
    createdBy: admin.uid,
    createdByEmail: admin.email || '',
    createdByName: admin.displayName || '',
    createdAt: serverTimestamp()
  });
  return id;
}

export async function getArticleRevisions(slug:string):Promise<ArticleRevision[]>{
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const snap=await getDocs(query(collection(db,'articleRevisions'), where('slug','==',slug), limit(100)));
  return snap.docs.map(d=>({id:d.id,...d.data()} as ArticleRevision)).sort((a:any,b:any)=>{
    const at=a.createdAt?.toDate?.()?.getTime?.() || 0; const bt=b.createdAt?.toDate?.()?.getTime?.() || 0; return bt-at;
  });
}

export async function restoreArticleRevision(revisionId:string):Promise<Article>{
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const snap=await getDoc(doc(db,'articleRevisions',revisionId)); if(!snap.exists()) throw new Error('Revision not found.');
  const source=snap.data()?.article as Article;
  if(!source?.slug) throw new Error('This revision is invalid.');
  const currentSnap=await getDoc(doc(db,'articles',source.slug));
  if(currentSnap.exists()) await createArticleRevision(normalizeArticleRecord(currentSnap.data(), currentSnap.id), 'before-restore');
  const article={...source};
  await saveArticle(article, {createRevision:false, revisionAction:'restored'});
  await createArticleRevision(article, 'restored');
  return article;
}

export async function duplicateArticleFromRevision(revisionId:string):Promise<Article>{
  const admin=auth.currentUser; if(!admin || !(await resolveMasterAccess(admin))) throw new Error('Admin access required.');
  const snap=await getDoc(doc(db,'articleRevisions',revisionId)); if(!snap.exists()) throw new Error('Revision not found.');
  const source={...(snap.data()?.article as Article)};
  if(!source?.slug) throw new Error('This revision is invalid.');
  const base=source.slug.replace(/-copy(?:-\d+)?$/,'');
  let slug=`${base}-copy`; let n=2;
  while((await getDoc(doc(db,'articles',slug))).exists()){ slug=`${base}-copy-${n++}`; }
  const duplicate:Article={...source,id:`article-${Date.now()}`,slug,title:`${source.title} (Copy)`,viewsCount:0,clapsCount:0,reactionCounts:{},isPublished:false,mainPublicationStatus:'unpublished',featured:false,pinned:false,trending:false,promotedToArticleSlug:undefined,sourcePostId:undefined,origin:'admin'};
  await saveArticle(duplicate,{createRevision:false,revisionAction:'manual'});
  await createArticleRevision(duplicate,'initial');
  return duplicate;
}

export async function saveArticle(article: Article, options:{createRevision?:boolean;revisionAction?:ArticleRevisionAction} = {}): Promise<Article> {
  if (!article.title || !article.slug) {
    throw new Error("Article must have a title and a valid slug.");
  }
  const articleDocRef = doc(db, 'articles', article.slug);
  const existingSnap = await getDoc(articleDocRef);
  if(existingSnap.exists() && await resolveMasterAccess(auth.currentUser) && options.createRevision !== false) { try { await createArticleRevision(normalizeArticleRecord(existingSnap.data(), existingSnap.id), options.revisionAction || 'auto-save'); } catch(e){ console.warn('Revision snapshot failed:',e); } }
  const isNewArticle = !existingSnap.exists();
  const dataToSave = stripUndefinedDeep({
    ...article,
    updatedAt: serverTimestamp(),
    createdAt: (article as any).createdAt || serverTimestamp()
  });
  await setDoc(articleDocRef, dataToSave, { merge: true });
  if (await resolveMasterAccess(auth.currentUser)) {
    try { await writeAdminAudit(isNewArticle?'created article':'updated article',`articles/${article.slug}`,existingSnap.exists()?existingSnap.data():null,article); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    if (isNewArticle) { try { await createArticleRevision({...article, ...dataToSave} as Article, 'initial'); } catch(e){ console.warn('Initial revision snapshot failed:', e); } }
  }

  // Every registered OFFSCRPT user receives an in-app notification when the admin
  // publishes a genuinely new article. Edits do not generate duplicate alerts.
  if (isNewArticle && checkIsAdmin(auth.currentUser?.email)) {
    try {
      const usersSnap = await getDocs(collection(db, 'users'));
      const recipients = usersSnap.docs.map(d => d.id);
      const actor = article.author;
      for (let i = 0; i < recipients.length; i += 450) {
        const batch = writeBatch(db);
        recipients.slice(i, i + 450).forEach(userId => {
          const notificationRef = doc(collection(db, 'users', userId, 'notifications'));
          batch.set(notificationRef, {
            type: 'article_published',
            actorId: auth.currentUser!.uid,
            actorUsername: actor.username || 'krishsarkar',
            actorName: actor.name || 'Krish Sarkar',
            actorAvatar: actor.avatar || '',
            message: `published a new article: ${article.title}`.slice(0, 200),
            targetType: 'article',
            targetId: article.slug,
            read: false,
            createdAt: serverTimestamp()
          });
        });
        await batch.commit();
      }
    } catch (notificationError) {
      // Publishing must remain successful even if notification fan-out is unavailable.
      console.warn('Article notification fan-out failed:', notificationError);
    }
  }
  void enqueueIndexSync({ operation: isNewArticle ? 'create' : 'update', contentId: article.slug, contentType: 'article', path: `articles/${article.slug}`, revision: String((article as any).editedAt || (article as any).updatedAt || ''), reason: isNewArticle ? 'article-created' : 'article-updated' }).catch(() => {});
  if (article.isPublished !== false && article.mainPublicationStatus !== 'unpublished') void enqueueIndexSync({ operation: 'publish', contentId: article.slug, contentType: 'article', path: `articles/${article.slug}` }).catch(() => {});
  return article;
}

async function resolveOriginalCreatorForPromotion(post: CommunityPost) {
  let profile:any = null;
  try {
    profile = post.authorUsername
      ? await getProfileByUsername(String(post.authorUsername))
      : (auth.currentUser?.uid === String(post.authorId) ? await getCommunityProfile(post.authorId) : null);
  } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
  const username = profile?.username || post.authorUsername || 'creator';
  const name = profile?.displayName || post.authorName || username;
  const avatar = profile?.photoURL || post.authorAvatar || '';
  return {
    uid: post.authorId,
    username,
    name,
    avatar,
    bio: profile?.bio || '',
    role: profile?.isVerified ? 'Verified Creator' : 'Creator',
    isVerified: !!(profile?.isVerified ?? post.isVerified),
    verificationColor: profile?.verificationColor || post.verificationColor
  };
}

export async function promoteCommunityBlogToMain(post: CommunityPost, collaborateAsEditor = true): Promise<Article> {
  if (!(await resolveMasterAccess())) throw new Error('Master admin access required.');
  if (post.type !== 'blog') throw new Error('Only a community blog can be promoted to the main publication.');
  const originalAuthor = await resolveOriginalCreatorForPromotion(post);
  const baseSlug = String(post.title || 'community-blog').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70) || 'community-blog';
  let slug = `community-${baseSlug}`;
  let n = 2;
  const blocks = Array.isArray(post.contentBlocks) && post.contentBlocks.length
    ? post.contentBlocks.map((b:any)=>({...b}))
    : [{type:'paragraph' as const, content:post.content}];
  // Re-publishing an existing source restores the same main article instead of creating duplicates.
  const existingSource = (await getDocs(query(collection(db,'articles'), where('sourcePostId','==',post.id), limit(10)))).docs.find(d => (d.data() as any).sourcePostId === post.id);
  if (existingSource) {
    slug = existingSource.id;
    const existingArticle = existingSource.data() as any;
    const restored = { ...existingArticle, id: existingSource.id, slug: existingSource.id, title: post.title, excerpt: post.excerpt || post.content.slice(0,240), coverImage: post.coverImage || '', coverImageAlt: post.coverImageAlt || post.title, category: post.category || 'Community', tags: Array.isArray(post.tags) ? post.tags : [], content: blocks, author: originalAuthor, originalAuthor, sourcePostId: post.id, sourceCommunityId: (post as any).communityId || undefined, isPublished: true, mainPublicationStatus: 'published', updatedAt: serverTimestamp() };
    await setDoc(existingSource.ref, stripUndefinedDeep(restored), { merge: true });
    try { const sourceRef = (post as any).communityId ? doc(db,'communities',(post as any).communityId,'posts',post.id) : doc(db,'posts',post.id); await updateDoc(sourceRef, { promotedToArticleSlug: slug, mainPublicationStatus: 'published', updatedAt: serverTimestamp() }); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    return { ...existingArticle, id: slug, slug, isPublished: true, mainPublicationStatus: 'published' } as Article;
  }
  while ((await getDoc(doc(db,'articles',slug))).exists()) slug = `community-${baseSlug}-${n++}`;
  const article: Article = {
    id: slug,
    slug,
    title: post.title,
    excerpt: post.excerpt || post.content.slice(0,240),
    coverImage: post.coverImage || '',
    coverImageAlt: post.coverImageAlt || post.title,
    coverImageCaption: post.coverImageCaption,
    category: post.category || 'Community',
    tags: Array.isArray(post.tags) ? post.tags : [],
    publishedAt: new Date().toISOString(),
    readingTimeMinutes: post.readingTimeMinutes || Math.max(1, Math.ceil(post.content.split(/\s+/).filter(Boolean).length/220)),
    featured: true,
    pinned: false,
    origin: 'community_blog',
    isPublished: true,
    mainPublicationStatus: 'published',
    sourcePostId: post.id,
    sourceCommunityId: (post as any).communityId || undefined,
    collaborators: collaborateAsEditor ? [{uid:originalAuthor.uid,username:originalAuthor.username,name:originalAuthor.name,role:'Original Creator'}] : [],
    originalAuthor,
    republishedBy: {uid: auth.currentUser?.uid || '', username: 'krishsarkar', name: 'Krish', avatar: auth.currentUser?.photoURL || DEFAULT_SITE_CONFIG.authorAvatarUrl},
    seriesId: (post as any).seriesId || undefined,
    seriesName: (post as any).seriesName || undefined,
    seriesOrder: (post as any).seriesOrder || undefined,
    editedAt: (post as any).editedAt || undefined,
    author: originalAuthor,
    content: blocks
  } as Article;
  const saved = await saveArticle(article);
  { const sourceRef = (post as any).communityId ? doc(db,'communities',(post as any).communityId,'posts',post.id) : doc(db,'posts',post.id); await updateDoc(sourceRef, { promotedToArticleSlug: saved.slug, promotedAt: serverTimestamp(), promotedBy: auth.currentUser?.uid || '', updatedAt: serverTimestamp() }); }
  return saved;
}

export async function approvePublicBlogEdit(sourcePostId:string, sourceCommunityId?:string, articleSlug?:string): Promise<void> {
  if (!(await resolveMasterAccess())) throw new Error('Master admin access required.');
  if(!sourcePostId) throw new Error('Source post is required.');
  let sourceRef = sourceCommunityId ? doc(db,'communities',sourceCommunityId,'posts',sourcePostId) : doc(db,'posts',sourcePostId);
  const sourceSnap = await getDoc(sourceRef);
  if(!sourceSnap.exists()) throw new Error('Original creator post was not found.');
  const source:any = sourceSnap.data();
  const slug = articleSlug || source.promotedToArticleSlug;
  if(!slug) throw new Error('No main publication is linked to this creator blog.');
  const articleRef=doc(db,'articles',slug);
  const articleSnap=await getDoc(articleRef);
  if(!articleSnap.exists()) throw new Error('Main article was not found.');
  const article:any=articleSnap.data();
  const patch:any={
    title:source.title||article.title, excerpt:source.excerpt||article.excerpt, coverImage:source.coverImage||article.coverImage, coverImageAlt:source.coverImageAlt||article.coverImageAlt, coverImageCaption:source.coverImageCaption||article.coverImageCaption, category:source.category||article.category, tags:Array.isArray(source.tags)?source.tags:article.tags, readingTimeMinutes:source.readingTimeMinutes||article.readingTimeMinutes, content:Array.isArray(source.contentBlocks)&&source.contentBlocks.length?source.contentBlocks:article.content, editedAt:source.editedAt||article.editedAt, editReviewStatus:'approved', editReviewedAt:serverTimestamp(), editReviewedBy:auth.currentUser?.uid||'', updatedAt:serverTimestamp()
  };
  await updateDoc(articleRef, stripUndefinedDeep(patch));
  await updateDoc(sourceRef,{editReviewStatus:'approved',editReviewedAt:serverTimestamp(),editReviewedBy:auth.currentUser?.uid||'',updatedAt:serverTimestamp()});
  try {
    if(source.authorId && source.authorId!==auth.currentUser?.uid) {
      await setDoc(doc(db,'users',source.authorId,'notifications',`edit-approval-${slug}-${Date.now()}`),{type:'blog_edit_approved',actorId:auth.currentUser?.uid||'',actorUsername:'krishsarkar',actorName:'Krish',message:`approved your edited blog: ${source.title||article.title}`.slice(0,200),targetType:'article',targetId:slug,read:false,createdAt:serverTimestamp()});
    }
  } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
}

export async function unpublishMainArticle(article: Article): Promise<void> {
  if (!(await resolveMasterAccess())) throw new Error('Master admin access required.');
  if (!article?.slug) throw new Error('Article slug is required.');
  const articleRef = doc(db, 'articles', article.slug);
  const existing = await getDoc(articleRef);
  if (!existing.exists()) throw new Error('Main article was not found in Firebase.');
  await updateDoc(articleRef, {
    isPublished: false,
    mainPublicationStatus: 'unpublished',
    updatedAt: serverTimestamp(),
    unpublishedAt: serverTimestamp(),
    unpublishedBy: auth.currentUser?.uid || ''
  });
  void enqueueIndexSync({ operation: 'unpublish', contentId: article.slug, contentType: 'article', path: `articles/${article.slug}`, reason: 'article-unpublished' }).catch(() => {});
  const data = existing.data() as any;
  if (data.sourcePostId) {
    try {
      const sourceRef = data.sourceCommunityId
        ? doc(db, 'communities', data.sourceCommunityId, 'posts', data.sourcePostId)
        : doc(db, 'posts', data.sourcePostId);
      await updateDoc(sourceRef, { mainPublicationStatus: 'unpublished', updatedAt: serverTimestamp() });
    } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
  }
}

export async function setArticleFeaturedStatus(
  article: Article, 
  isFeatured: boolean, 
  isPinned?: boolean
): Promise<void> {
  if (!article.slug) return;
  const articleDocRef = doc(db, 'articles', article.slug);
  const dataToSave = {
    ...article,
    featured: isFeatured,
    pinned: isPinned !== undefined ? isPinned : isFeatured,
    updatedAt: serverTimestamp(),
  };
  await setDoc(articleDocRef, dataToSave, { merge: true });
}

export async function syncAuthorToAllCloudArticles(author: {
  name: string;
  role: string;
  avatar: string;
  bio?: string;
  uid?: string;
  username?: string;
}): Promise<number> {
  const articlesRef = collection(db, 'articles');
  const snap = await getDocs(articlesRef);
  let updatedCount = 0;
  
  // Update all cloud articles in Firestore
  for (const docSnap of snap.docs) {
    const existing = docSnap.data();
    await setDoc(docSnap.ref, {
      ...existing,
      author: {
        uid: author.uid,
        username: author.username,
        name: author.name || 'Krish',
        role: author.role || 'Founder & Systems Architect',
        avatar: author.avatar || '',
        isVerified: true,
        verificationColor: '#2196F3',
        bio: author.bio || existing.author?.bio || ''
      },
      updatedAt: serverTimestamp()
    }, { merge: true });
    updatedCount++;
  }

  // Also, if Firestore had fewer articles than INITIAL_ARTICLES, seed any missing with the new author info
  for (const initArt of INITIAL_ARTICLES) {
    const docRef = doc(db, 'articles', initArt.slug);
    const existingDoc = await getDoc(docRef);
    if (!existingDoc.exists()) {
      await setDoc(docRef, {
        ...initArt,
        author: {
          uid: author.uid,
          username: author.username,
          name: author.name || 'Krish',
          role: author.role || 'Founder & Systems Architect',
          avatar: author.avatar || '',
          bio: author.bio || initArt.author?.bio || ''
        },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      updatedCount++;
    }
  }

  return updatedCount;
}

export async function deleteArticle(slug: string): Promise<void> {
  if (!slug) return;
  const before=await getDoc(doc(db,'articles',slug)).catch((error)=>{console.warn('Article snapshot lookup failed:',error);return null});
  await deleteDoc(doc(db, 'articles', slug));
  if(await resolveMasterAccess(auth.currentUser)){ try { await writeAdminAudit('deleted article',`articles/${slug}`,before?.exists?before.data():null,null); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); } }
  await setDoc(doc(db, 'deleted_articles', slug), {
    slug,
    deletedAt: serverTimestamp()
  });
  void enqueueIndexSync({ operation: 'delete', contentId: slug, contentType: 'article', path: `articles/${slug}`, reason: 'article-deleted' }).catch(() => {});
}

// ==========================================
// 4. ARTICLE COMMENTS (REAL FIRESTORE)
// ==========================================

export interface ArticleCommentExtended extends ArticleComment { parentId?:string; mentionedUsernames?:string[]; editedAt?:string; isHidden?:boolean; isDeleted?:boolean; moderationReason?:string; likeCount?:number; authorIsArticleAuthor?:boolean; }
export function subscribeArticleComments(articleSlug:string,callback:(comments:ArticleCommentExtended[])=>void):()=>void{
 const ref=collection(db,'articles',articleSlug,'comments'); const q=query(ref,orderBy('createdAt','desc')); return onSnapshot(q,snap=>callback(snap.docs.map(d=>{const x:any=d.data();return{id:d.id,articleSlug,authorId:x.authorId||'',authorName:x.authorName||'Architect',authorAvatar:x.authorAvatar||'',authorUsername:x.authorUsername||'',isVerified:!!x.isVerified,verificationColor:x.verificationColor||'#2196F3',content:x.isDeleted?'[deleted]':x.content||'',createdAt:x.createdAt instanceof Timestamp?x.createdAt.toDate().toISOString():String(x.createdAt||new Date().toISOString()),parentId:x.parentId||'',mentionedUsernames:Array.isArray(x.mentionedUsernames)?x.mentionedUsernames:[],editedAt:x.editedAt instanceof Timestamp?x.editedAt.toDate().toISOString():x.editedAt||'',isHidden:!!x.isHidden,isDeleted:!!x.isDeleted,likeCount:Number(x.likeCount||0)} as ArticleCommentExtended})),e=>{console.error('Article comments subscription failed:',e);callback([])});}
export async function addArticleComment(articleSlug:string,commentData:{authorId:string;authorName:string;authorAvatar?:string;authorUsername?:string;isVerified?:boolean;verificationColor?:string;content:string;parentId?:string}):Promise<ArticleCommentExtended>{
 if(!auth.currentUser||auth.currentUser.uid!==commentData.authorId)throw new Error('Authentication required.'); const content=commentData.content.trim(); if(!content)throw new Error('Comment cannot be empty.'); if(content.length>2000)throw new Error('Comment is too long.'); const commentId=`comment-${crypto.randomUUID()}`; const ref=doc(db,'articles',articleSlug,'comments',commentId); const mentionedUsernames=Array.from(content.matchAll(/@([a-zA-Z0-9_]{2,32})/g)).map(m=>m[1].toLowerCase()).slice(0,20); const data={...commentData,content,articleSlug,parentId:commentData.parentId||'',mentionedUsernames,isHidden:false,isDeleted:false,likeCount:0,createdAt:serverTimestamp(),updatedAt:serverTimestamp()}; await setDoc(ref,data);return{id:commentId,articleSlug,...commentData,content,createdAt:new Date().toISOString(),parentId:commentData.parentId||'',mentionedUsernames,isHidden:false,isDeleted:false,likeCount:0};}
export async function updateArticleComment(articleSlug:string,commentId:string,content:string){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');const ref=doc(db,'articles',articleSlug,'comments',commentId);const snap=await getDoc(ref);if(!snap.exists())throw new Error('Comment not found.');if(snap.data().authorId!==u.uid)throw new Error('You can only edit your own comment.');const clean=content.trim();if(!clean||clean.length>2000)throw new Error('Comment must contain 1–2000 characters.');await updateDoc(ref,{content:clean,mentionedUsernames:Array.from(clean.matchAll(/@([a-zA-Z0-9_]{2,32})/g)).map(m=>m[1].toLowerCase()).slice(0,20),editedAt:serverTimestamp(),updatedAt:serverTimestamp()});}
export async function deleteArticleComment(articleSlug:string,commentId:string){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');const ref=doc(db,'articles',articleSlug,'comments',commentId);const snap=await getDoc(ref);if(!snap.exists())return;if(snap.data().authorId!==u.uid&&!checkIsAdmin(u.email)&&!(await resolveMasterAccess(u)))throw new Error('You can only delete your own comment.');if(checkIsAdmin(u.email)||await resolveMasterAccess(u))await updateDoc(ref,{isDeleted:true,content:'',updatedAt:serverTimestamp()});else await deleteDoc(ref);}
export async function moderateArticleComment(articleSlug:string,commentId:string,hidden:boolean,reason=''){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');const perms=await getModeratorPermissions(u.uid);if(!checkIsAdmin(u.email)&&!perms.moderateComments)throw new Error('Moderator permission required.');await updateDoc(doc(db,'articles',articleSlug,'comments',commentId),{isHidden:hidden,moderationReason:reason.slice(0,300),updatedAt:serverTimestamp()});}
export async function reactToArticleComment(articleSlug:string,commentId:string,active:boolean){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');const reaction=doc(db,'articles',articleSlug,'comments',commentId,'reactions',u.uid);const parent=doc(db,'articles',articleSlug,'comments',commentId);await runTransaction(db,async tx=>{const cur=await tx.get(parent);const n=Math.max(0,Number(cur.data()?.likeCount||0)+(active?1:-1));if(active)tx.set(reaction,{userId:u.uid,createdAt:serverTimestamp()});else tx.delete(reaction);tx.update(parent,{likeCount:n,updatedAt:serverTimestamp()})});}
export async function toggleArticleCommentReaction(articleSlug:string,commentId:string){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');const reaction=doc(db,'articles',articleSlug,'comments',commentId,'reactions',u.uid);const parent=doc(db,'articles',articleSlug,'comments',commentId);return runTransaction(db,async tx=>{const cur=await tx.get(parent);const own=await tx.get(reaction);const active=!own.exists();const n=Math.max(0,Number(cur.data()?.likeCount||0)+(active?1:-1));if(active)tx.set(reaction,{userId:u.uid,createdAt:serverTimestamp()});else tx.delete(reaction);tx.update(parent,{likeCount:n,updatedAt:serverTimestamp()});return active})}
export async function reportArticleComment(articleSlug:string,commentId:string,reason:string){const u=auth.currentUser;if(!u)throw new Error('Authentication required.');await setDoc(doc(db,'reports',`comment-${crypto.randomUUID()}`),{reporterId:u.uid,targetType:'comment',targetId:`articles/${articleSlug}/comments/${commentId}`,reason:reason.slice(0,500),status:'open',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}

// ==========================================
// 5. NEWSLETTER SUBSCRIBERS (CLOUD PERSISTENCE)
// ==========================================

export interface NewsletterSubscriber {
  id: string;
  email: string;
  subscribedAt: string;
}

export async function subscribeNewsletter(email: string): Promise<{ status: 'success' | 'already_subscribed'; message: string }> {
  const cleanEmail = email.toLowerCase().trim();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!cleanEmail || !emailRegex.test(cleanEmail)) {
    throw new Error("Please enter a valid email address (e.g., name@domain.com).");
  }

  // Safe document key for email
  const docId = cleanEmail.replace(/[^a-z0-9@._-]/g, '_');
  const subDocRef = doc(db, 'newsletter_subscribers', docId);

  try {
    await setDoc(subDocRef, {
      email: cleanEmail,
      subscribedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      active: true,
      source: 'web_portal'
    });

    return {
      status: 'success',
      message: 'You are successfully subscribed to the architectural dispatches.'
    };
  } catch (error: any) {
    // Subscriber documents are intentionally not publicly readable. A write to
    // an existing deterministic document is denied, which safely indicates an
    // existing subscription without exposing the address or subscriber list.
    if (error?.code === 'permission-denied') {
      return {
        status: 'already_subscribed',
        message: 'This email address is already subscribed to the dispatches.'
      };
    }
    console.error("Failed to persist newsletter subscriber:", error);
    throw new Error(error.message || "Failed to register subscription. Please try again.");
  }
}

export async function adminDeleteCommunityPost(postId: string): Promise<void> {
  if (!auth.currentUser || !checkIsAdmin(auth.currentUser.email)) {
    throw new Error("Unauthorized: Admin privileges required.");
  }
  await deletePost(postId);
}

export async function adminDeleteArticle(slug: string): Promise<void> {
  if (!auth.currentUser || !checkIsAdmin(auth.currentUser.email)) {
    throw new Error("Unauthorized: Admin privileges required.");
  }
  await deleteArticle(slug);
}

export async function getNewsletterSubscribers(): Promise<NewsletterSubscriber[]> {
  try {
    const snap = await getDocs(collection(db, 'newsletter_subscribers'));
    return snap.docs.map((d) => {
      const data = d.data();
      let dateStr = 'Recently';
      if (data.subscribedAt?.toDate) {
        dateStr = data.subscribedAt.toDate().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      }
      return {
        id: d.id,
        email: data.email || d.id,
        subscribedAt: dateStr
      };
    });
  } catch (error) {
    console.warn("Could not load newsletter subscribers (admin privileges required):", error);
    return [];
  }
}

