import React, { useState, useEffect, useRef } from 'react';
import { Article, PageView, SiteConfig, BentoLink, CommunityUser } from './types';
import { 
  subscribeArticles, 
  subscribeSiteConfig, 
  subscribeBentoLinks, 
  deleteArticle, 
  saveSiteConfig, 
  saveBentoLinks,
  DEFAULT_SITE_CONFIG,
  DEFAULT_BENTO_LINKS
} from './lib/cms';
import { Header } from './components/Header';
import { MarqueeTicker } from './components/MarqueeTicker';
import { HomeView } from './components/HomeView';
import { BlogView } from './components/BlogView';
import { ArticleView } from './components/ArticleView';
import { AboutView } from './components/AboutView';
import { ContactView } from './components/ContactView';
import { LinksView } from './components/LinksView';
import { Footer } from './components/Footer';
import { SearchModal } from './components/SearchModal';
import { CommandPalette } from './components/CommandPalette';
import { HistoryView } from './components/HistoryView';
import { AdminStudioModal } from './components/AdminStudioModal';
import { RssModal } from './components/RssModal';
import { CommunityView } from './components/CommunityView';
import { CommunityPostView } from './components/CommunityPostView';
import { CommunityProfileView } from './components/CommunityProfileView';
import { backfillPublicProfilesForAllUsers } from './lib/community';
import { SavedView } from './components/SavedView';
import { NotificationsView } from './components/NotificationsView';
import { AccountDashboardView } from './components/AccountDashboardView';
import { MarketplaceErrorBoundary } from './components/MarketplaceErrorBoundary';
import { PurchasesView } from './components/PurchasesView';
import { MarketplaceView } from './components/MarketplaceView';
import { SavedProductsView } from './components/SavedProductsView';
import { ActivityCenterView } from './components/ActivityCenterView';
import { CreatorDashboardView } from './components/CreatorDashboardView';
import { PreferencesView } from './components/PreferencesView';
import { ExploreView } from './components/ExploreView';
import { SeriesView } from './components/SeriesView';
import { CreatorView } from './components/CreatorView';
import { CommerceProductView } from './components/CommerceProductView';
import { TopicView } from './components/TopicView';
import { SocialHubView } from './components/SocialHubView';
import { CreatorDiscoveryView } from './components/CreatorDiscoveryView';
import { UniqueHandleModal } from './components/UniqueHandleModal';
import { SystemHealthView } from './components/SystemHealthView';
import { ChangelogView } from './components/ChangelogView';
import { QuestionView } from './components/QuestionView';
import { SiteAnnouncementPopup } from './components/SiteAnnouncementPopup';
import { auth, checkIsAdmin } from './lib/firebase';
import { isPlatformModerator } from './lib/social';
import { getCommunityProfile, getProfileByUsername, ensureCommunityProfileForUser, subscribeUserSaves, toggleUserSaveInCloud, getReadingProgress, saveReadingProgress, ensureFollowingAuthor, subscribeCommunityProfile } from './lib/community';
import { emitActivityEvent } from './lib/activity';
import { subscribeReadingQueue, toggleReadingQueue, subscribeThemePreference } from './lib/account';
import { syncAdminAuthorProfile, syncAuthorToAllCloudArticles, getSiteConfig } from './lib/cms';
import { Loader2 } from 'lucide-react';
import { notifyToast } from './lib/toast';
import { recordArticleAnalyticsEvent } from './lib/analytics';
import { runSyncedOperation } from './lib/sync';
import { resolveMasterAccess } from './lib/masterControl';
import { reportRuntimeError } from './lib/runtime';
import { LearnView } from './components/LearnView';
import { KnowledgeView } from './components/KnowledgeView';
import { applyAIThemeToDocument } from './lib/aiTheme';

const SAVED_SLUGS_GUEST_KEY = 'offscrpt_saved_slugs_guest_v1';
const SAVED_COMMUNITY_GUEST_KEY = 'offscrpt_saved_community_guest_v1';
const savedSlugsKey = (uid?: string | null) => uid ? `offscrpt:saved:articles:${uid}:v2` : SAVED_SLUGS_GUEST_KEY;
const savedCommunityKey = (uid?: string | null) => uid ? `offscrpt:saved:posts:${uid}:v2` : SAVED_COMMUNITY_GUEST_KEY;


class PageErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError:boolean; message:string}> {
  state = { hasError: false, message: '' };
  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, message: error instanceof Error ? error.message : String(error || 'Unexpected error') };
  }
  componentDidCatch(error: unknown) {
    console.error('OFFSCRPT page runtime error:', error);
    void reportRuntimeError(error, 'page-boundary');
  }
  componentDidUpdate(prevProps: {children: React.ReactNode}) {
    if (prevProps.children !== this.props.children && this.state.hasError) this.setState({hasError:false, message:''});
  }
  render() {
    if (this.state.hasError) return <div className="max-w-3xl mx-auto px-4 py-24"><div className="border-4 border-black bg-white p-6 neo-shadow"><div className="font-mono text-[10px] font-black uppercase text-red-600">PAGE ERROR</div><h2 className="font-display font-black text-3xl uppercase mt-2">THIS PAGE COULD NOT RENDER</h2><p className="font-mono text-xs text-neutral-600 mt-3 break-words">{this.state.message}</p><button className="mt-5 border-2 border-black bg-[var(--color-primary)] px-4 py-2 font-mono text-xs font-black uppercase" onClick={() => this.setState({hasError:false,message:''})}>RETRY PAGE</button></div></div>;
    return this.props.children;
  }
}

function ToastHost(){
  const [toasts,setToasts]=React.useState<Array<{id:number;message:string;kind:'success'|'error'|'info';duration:number}>>([]);
  React.useEffect(()=>{
    const onToast=(event:Event)=>{
      const detail=(event as CustomEvent).detail||{};
      const message=String(detail.message||'');
      const kind=(detail.kind||'info') as 'success'|'error'|'info';
      const now=Date.now();
      const id=now+Math.random();
      const item={id,message,kind,duration:Number(detail.duration)||3200};
      setToasts(prev=>{
        const duplicate=prev.some(t=>t.message===message && t.kind===kind);
        return duplicate?prev:[...prev.slice(-3),item];
      });
      window.setTimeout(()=>setToasts(prev=>prev.filter(t=>t.id!==id)),item.duration);
    };
    window.addEventListener('offscrpt:toast',onToast);
    return ()=>window.removeEventListener('offscrpt:toast',onToast);
  },[]);
  const tone={success:'bg-[#00FF41]',error:'bg-[#FF4D6D]',info:'bg-[#00E0FF]'};
  return <div className="fixed right-4 bottom-4 z-[500] w-[min(92vw,360px)] space-y-3 pointer-events-none">
    {toasts.map(t=><div key={t.id} className={`pointer-events-auto border-4 border-black neo-shadow-sm ${tone[t.kind]} text-black`}>
      <div className="flex items-start gap-3 p-3">
        <div className="flex-1 font-display font-black uppercase text-sm leading-tight">{t.message}</div>
        <button aria-label="Dismiss notification" className="border-2 border-black bg-white px-2 py-0.5 font-mono text-xs font-black pointer-events-auto" onClick={()=>setToasts(prev=>prev.filter(x=>x.id!==t.id))}>×</button>
      </div>
      <div className="h-1 bg-black/20 overflow-hidden"><div className="h-full bg-black origin-left animate-[toastbar_3200ms_linear_forwards]" style={{animationDuration:`${t.duration}ms`}} /></div>
    </div>)}
  </div>;
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<PageView>('home');
  const [activeArticleSlug, setActiveArticleSlug] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All Posts');
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const [siteConfig, setSiteConfig] = useState<SiteConfig>(DEFAULT_SITE_CONFIG);
  const [bentoLinks, setBentoLinks] = useState<BentoLink[]>(DEFAULT_BENTO_LINKS);

  useEffect(() => { applyAIThemeToDocument(siteConfig.aiTheme); }, [siteConfig.aiTheme]);

  // Real-time Firestore Subscriptions for Cloud CMS Data
  useEffect(() => {
    const unsubConfig = subscribeSiteConfig((config) => {
      setSiteConfig(config);
    });
    const unsubBento = subscribeBentoLinks((links) => {
      setBentoLinks(links);
    });
    const unsubArticles = subscribeArticles((fetched) => {
      setArticles(fetched);
      setLoading(false);
    });

    return () => {
      unsubConfig();
      unsubBento();
      unsubArticles();
    };
  }, []);

  const handleUpdateBentoLinks = async (links: BentoLink[]) => {
    setBentoLinks(links);
    try {
      await saveBentoLinks(links);
    } catch (e) {
      console.error("Failed to persist bento links to Firestore:", e);
    }
  };

  // Modals state
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isCmsOpen, setIsCmsOpen] = useState(false);
  const [canAccessCms, setCanAccessCms] = useState(false);
  const [cloudMasterAdmin, setCloudMasterAdmin] = useState(false);
  const [cmsEditorRequest, setCmsEditorRequest] = useState<{ mode: 'new' | 'edit'; article?: Article; token: number } | null>(null);
  const [isRssOpen, setIsRssOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = auth.onAuthStateChanged(async (user) => {
      if (!user) { if (!cancelled) { setCanAccessCms(false); setCloudMasterAdmin(false); } return; }
      const master = await resolveMasterAccess(user);
      let moderator = false;
      if (!master) moderator = await isPlatformModerator(user.uid);
      if (!cancelled) { setCloudMasterAdmin(master); setCanAccessCms(master || moderator); }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);


  // Bookmarked / Saved articles state
  const [savedSlugs, setSavedSlugs] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(SAVED_SLUGS_GUEST_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [savedCommunityPostIds, setSavedCommunityPostIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(SAVED_COMMUNITY_GUEST_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [userAuth, setUserAuth] = useState(auth.currentUser);
  const saveSubscriptionRef = React.useRef<(() => void) | null>(null);
  const authGenerationRef = React.useRef(0);
  const [userProfile, setUserProfile] = useState<CommunityUser | null>(null);
  const [continueReadingSlug, setContinueReadingSlug] = useState<string | null>(null);
  const [readingQueueIds, setReadingQueueIds] = useState<string[]>([]);
  const [isHandleModalOpen, setIsHandleModalOpen] = useState(false);
  const handlePromptedUidRef = useRef<string | null>(null);

  useEffect(() => {
    const onProfileUpdated = (event: Event) => {
      const profile = (event as CustomEvent).detail as CommunityUser | undefined;
      if (profile?.uid === auth.currentUser?.uid) {
        setUserProfile(profile);
        if (profile.username) setIsHandleModalOpen(false);
      }
    };
    window.addEventListener('offscrpt:profile-updated', onProfileUpdated);
    return () => window.removeEventListener('offscrpt:profile-updated', onProfileUpdated);
  }, []);

  // Sync auth state & cloud saved items
  useEffect(() => {
    const unsub = auth.onAuthStateChanged(async (user) => {
      const generation = ++authGenerationRef.current;
      saveSubscriptionRef.current?.();
      saveSubscriptionRef.current = null;
      setUserAuth(user);
      if (user) {
        // Load or automatically create the persistent cloud profile.
        // Existing handles are restored from Firestore; first-time accounts
        // start unclaimed and are prompted to explicitly choose a unique handle.
        try {
          let prof = await getCommunityProfile(user.uid);
          if (!prof) {
            prof = await ensureCommunityProfileForUser(user);
          }

          if (checkIsAdmin(user.email)) {
            const cloudConfig = await getSiteConfig();
            if (generation !== authGenerationRef.current) return;
            try {
              const syncKey = `offscrpt:admin-author-sync:${user.uid}`;
              let recentlySynced = false;
              try { recentlySynced = Number(sessionStorage.getItem(syncKey) || 0) > Date.now() - 1_800_000; } catch (error) { console.warn('Admin sync session marker unavailable:', error); }
              if (!recentlySynced) {
                // The canonical publication author is the reserved @krishsarkar profile.
                // Never let a stale siteConfig.authorAvatarUrl or a secondary admin
                // Google account overwrite the live profile identity.
                const canonical = await getProfileByUsername(cloudConfig.authorProfileUsername || 'krishsarkar');
                const canonicalProfile = canonical?.uid ? canonical : (prof?.username === 'krishsarkar' ? prof : null);
                const authorName = canonicalProfile?.displayName || cloudConfig.authorName || user.displayName || 'Krish Sarkar';
                const authorAvatar = canonicalProfile?.photoURL || cloudConfig.authorAvatarUrl || user.photoURL || '';
                const authorBio = cloudConfig.aboutMeBio || cloudConfig.manifestoText || canonicalProfile?.bio || '';
                const authorRole = cloudConfig.authorRole || canonicalProfile?.role || 'Founder & Systems Architect';
                const synced = await syncAdminAuthorProfile({
                  name: authorName,
                  role: authorRole,
                  avatar: authorAvatar,
                  bio: authorBio
                });
                await syncAuthorToAllCloudArticles({
                  name: authorName,
                  role: authorRole,
                  avatar: authorAvatar,
                  bio: authorBio,
                  uid: synced.uid, username: synced.username
                });
                try { sessionStorage.setItem(syncKey, String(Date.now())); } catch (error) { console.warn('Admin sync session marker write unavailable:', error); }
                prof = await getCommunityProfile(synced.uid) || canonicalProfile || prof;
              }
            } catch (adminSyncError) {
              console.warn('Admin author sync skipped:', adminSyncError);
            }
          }

          if (prof) {
            await ensureFollowingAuthor(user.uid, prof.username);
          }
          if (generation !== authGenerationRef.current) return;
          setUserProfile(prof);
          // Prompt only once per auth session for an actually unclaimed account.
          // A successful handle claim must not reopen the modal on an auth refresh.
          const shouldPromptHandle = !prof.username && handlePromptedUidRef.current !== user.uid;
          if (shouldPromptHandle) handlePromptedUidRef.current = user.uid;
          setIsHandleModalOpen(shouldPromptHandle);
          // Newly-created accounts have no reserved @handle. Prompt once so the
          // user can explicitly claim a globally unique handle instead of silently
          // reserving their Google display name. Cancel remains supported; the same
          // identity editor is available from Settings.
        } catch (e) {
          console.error('Error loading/creating user profile:', e);
          // Do not repeatedly force users into the manual claim modal. It is
          // is only a recovery UI if profile creation/loading fails.
          setUserProfile(null);
        }

        // Cloud saves are authoritative for signed-in users and stream to every tab/device.
        // Do not merge stale device-local state into the account, which would resurrect saves
        // that were removed elsewhere.
        if (generation !== authGenerationRef.current) return;
        saveSubscriptionRef.current = subscribeUserSaves(user.uid, cloudSaves => {
          if (generation !== authGenerationRef.current) return;
          const cloudArticleSlugs = cloudSaves.filter(s => s.itemType === 'article').map(s => s.itemId);
          const cloudCommunityIds = cloudSaves.filter(s => s.itemType === 'post').map(s => s.itemId);
          setSavedSlugs(cloudArticleSlugs);
          setSavedCommunityPostIds(cloudCommunityIds);
          try {
            localStorage.setItem(savedSlugsKey(user.uid), JSON.stringify(cloudArticleSlugs));
            localStorage.setItem(savedCommunityKey(user.uid), JSON.stringify(cloudCommunityIds));
          } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
        }, error => console.warn('Cloud save synchronization failed:', error));


        try {
          const progress = await getReadingProgress(user.uid);
          if (generation !== authGenerationRef.current) return;
          setContinueReadingSlug(progress?.articleSlug || null);
        } catch (e) {
          console.error("Error loading reading progress:", e);
        }
      } else {
        saveSubscriptionRef.current?.();
        saveSubscriptionRef.current = null;
        setUserProfile(null);
        setContinueReadingSlug(null);
        try {
          const guestArticles = JSON.parse(localStorage.getItem(SAVED_SLUGS_GUEST_KEY) || '[]');
          const guestPosts = JSON.parse(localStorage.getItem(SAVED_COMMUNITY_GUEST_KEY) || '[]');
          setSavedSlugs(Array.isArray(guestArticles) ? guestArticles : []);
          setSavedCommunityPostIds(Array.isArray(guestPosts) ? guestPosts : []);
        } catch {
          setSavedSlugs([]); setSavedCommunityPostIds([]);
        }
      }
    });
    return () => {
      unsub();
      saveSubscriptionRef.current?.();
      saveSubscriptionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!userProfile?.uid) return;
    return subscribeCommunityProfile(userProfile.uid, liveProfile => {
      if (liveProfile) setUserProfile(liveProfile);
    });
  }, [userProfile?.uid]);

  useEffect(() => {
    if (!userAuth?.uid) { setReadingQueueIds([]); return; }
    return subscribeReadingQueue(items => setReadingQueueIds(items.filter(item => item.itemType === 'article').map(item => item.itemId)));
  }, [userAuth?.uid]);

  // Dynamic theme colors synced to global site configuration
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-primary', siteConfig.themePrimaryColor || '#FFD600');
    root.style.setProperty('--color-secondary', siteConfig.themeSecondaryColor || '#00E0FF');
    root.style.setProperty('--color-accent', siteConfig.themeAccentColor || '#FF60B5');
    root.style.setProperty('--color-success', siteConfig.themeSuccessColor || '#00FF41');
  }, [
    siteConfig.themePrimaryColor,
    siteConfig.themeSecondaryColor,
    siteConfig.themeAccentColor,
    siteConfig.themeSuccessColor
  ]);

  // Account theme preference: cached immediately, then cloud-synced once signed in.
  useEffect(() => {
    const apply = (theme: 'light' | 'dark') => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
      try { localStorage.setItem('offscrpt:theme', theme); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    };
    try {
      const cached = localStorage.getItem('offscrpt:theme');
      // New visitors default to light mode. Explicit local preferences still win.
      apply(cached === 'dark' ? 'dark' : 'light');
    } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
    if (!userAuth?.uid) return;
    return subscribeThemePreference(apply);
  }, [userAuth?.uid]);

  // Keep the browser favicon synchronized with the cloud-managed site logo.
  useEffect(() => {
    const fallbackFavicon = '/offscrpt-icon.svg';
    const logoUrl = siteConfig.logoImageUrl?.trim() || fallbackFavicon;
    const brandName = `${siteConfig.logoPart1 || ''}${siteConfig.logoPart2 || ''}`.trim() || 'OFFSCRPT';

    let favicon = document.querySelector<HTMLLinkElement>('link#site-favicon');
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.id = 'site-favicon';
      favicon.rel = 'icon';
      favicon.type = 'image/png';
      document.head.appendChild(favicon);
    }
    favicon.href = logoUrl;

    // Keep PWA/home-screen metadata synchronized with the CMS-managed logo.
    const appleIcon = document.querySelector<HTMLLinkElement>('link#site-apple-touch-icon');
    if (appleIcon) appleIcon.href = logoUrl;

    const manifestLink = document.querySelector<HTMLLinkElement>('link#site-manifest');
    if (manifestLink) {
      const manifest = {
        name: brandName,
        short_name: brandName,
        description: siteConfig.metaDescription || 'Independent technology publication for builders.',
        // Blob-backed manifests need absolute URLs for hash routes.
        start_url: `${window.location.origin}/#home`,
        scope: `${window.location.origin}/`,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: siteConfig.themePrimaryColor || '#FFD600',
        orientation: 'portrait-primary',
        icons: [
          { src: (/^https?:\/\//i.test(String(logoUrl)) ? String(logoUrl) : `${window.location.origin}/offscrpt-icon.svg`), sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
          { src: (/^https?:\/\//i.test(String(logoUrl)) ? String(logoUrl) : `${window.location.origin}/offscrpt-icon.svg`), sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      };
      const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
      const objectUrl = URL.createObjectURL(blob);
      manifestLink.href = objectUrl;
      manifestLink.dataset.dynamicManifest = objectUrl;
      // Revoke this blob URL when the manifest configuration changes/unmounts
      // so repeated CMS updates do not leak object URLs in the browser.
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    }

    document.title = `${brandName} — Tech Publication for Builders`;

    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = siteConfig.themePrimaryColor || '#FFD600';
  }, [siteConfig.logoImageUrl, siteConfig.logoPart1, siteConfig.logoPart2, siteConfig.themePrimaryColor]);

  // One-time master-admin repair keeps the public handle directory complete for
  // existing accounts. New/updated profiles mirror themselves on login/edit.
  useEffect(() => {
    if (!userAuth?.uid || !checkIsAdmin(userAuth.email)) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await backfillPublicProfilesForAllUsers();
        if (!cancelled && result.mirrored > 0) console.info('Public profile directory repaired:', result);
      } catch (error) {
        if (!cancelled) console.warn('Public profile directory repair skipped:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [userAuth?.uid, userAuth?.email]);

  // URL Hash Sync for standard navigation & browser back button support
  useEffect(() => {
    const handleHashChange = () => {
      const pathname = window.location.pathname.replace(/\/$/, '') || '/';
      const pathMatch = pathname.match(/^\/article\/([^/]+)$/);
      const seriesMatch = pathname.match(/^\/series\/([^/]+)(?:\/part-(\d+))?$/);
      const profileMatch = pathname.match(/^\/@([^/]+)$/);
      const postMatch = pathname.match(/^\/post\/([^/]+)$/);
      const discussionMatch = pathname.match(/^\/discussion\/([^/]+)$/);
      const questionMatch = pathname.match(/^\/question\/([^/]+)$/);
      const topicMatch = pathname.match(/^\/topic\/([^/]+)$/);
      const productMatch = pathname.match(/^\/product\/([^/]+)$/);
      if(pathMatch){setActiveArticleSlug(decodeURIComponent(pathMatch[1]));setCurrentPage('article');return;}
      if(seriesMatch){setActiveArticleSlug(decodeURIComponent(seriesMatch[1]));setCurrentPage('series');return;}
      if(profileMatch){setActiveArticleSlug(decodeURIComponent(profileMatch[1]));setCurrentPage('community_profile');return;}
      if(postMatch){setActiveArticleSlug(decodeURIComponent(postMatch[1]));setCurrentPage('community_post');return;}
      if(discussionMatch){setActiveArticleSlug(decodeURIComponent(discussionMatch[1]));setCurrentPage('community_post');return;}
      if(questionMatch){setActiveArticleSlug(decodeURIComponent(questionMatch[1]));setCurrentPage('question');return;}
      if(productMatch){setActiveArticleSlug(decodeURIComponent(productMatch[1]));setCurrentPage('product');return;}
      if(topicMatch){setActiveArticleSlug(decodeURIComponent(topicMatch[1]));setCurrentPage('topic');return;}
      const hash = window.location.hash.replace('#', '');
      if (!hash || hash === 'home') {
        setCurrentPage('home');
        setActiveArticleSlug(null);
      } else if (hash === 'blog') {
        setCurrentPage('blog');
        setActiveArticleSlug(null);
      } else if (hash.startsWith('article/')) {
        const slug = hash.replace('article/', '');
        setActiveArticleSlug(slug);
        setCurrentPage('article');
      } else if (hash === 'about') {
        setCurrentPage('about');
        setActiveArticleSlug(null);
      } else if (hash === 'contact') {
        setCurrentPage('contact');
        setActiveArticleSlug(null);
      } else if (hash === 'learn' || hash === 'ai' || hash === 'study') {
        setCurrentPage('learn');
        setActiveArticleSlug(null);
      } else if (hash === 'changelog') {
        setCurrentPage('changelog');
        setActiveArticleSlug(null);
      } else if (hash === 'links') {
        setCurrentPage('links');
        setActiveArticleSlug(null);
      } else if (hash === 'saved') {
        setCurrentPage('saved');
        setActiveArticleSlug(null);
      } else if (hash === 'history') {
        setCurrentPage('history');
        setActiveArticleSlug(null);
      } else if (hash === 'shop' || hash === 'marketplace' || hash.startsWith('shop?') || hash.startsWith('shop/category/') || hash.startsWith('marketplace?')) {
        setCurrentPage('shop');
        setActiveArticleSlug(null);
      } else if (hash === 'saved-products' || hash === 'wishlist') {
        setCurrentPage('saved_products');
        setActiveArticleSlug(null);
      } else if (hash === 'purchases' || hash === 'my-purchases') {
        setCurrentPage('purchases');
        setActiveArticleSlug(null);
      } else if (hash === 'dashboard' || hash === 'my') {
        setCurrentPage('dashboard');
        setActiveArticleSlug(null);
      } else if (hash === 'activity') {
        setCurrentPage('activity');
        setActiveArticleSlug(null);
      } else if (hash === 'creator-studio' || hash === 'creator_studio') {
        setCurrentPage('creator_studio');
        setActiveArticleSlug(null);
      } else if (hash === 'preferences' || hash === 'settings') {
        setCurrentPage('preferences');
        setActiveArticleSlug(null);
      } else if (hash === 'notifications') {
        setCurrentPage('notifications');
        setActiveArticleSlug(null);
      } else if (hash === 'series' || hash.startsWith('series/')) {
        setCurrentPage('series');
        setActiveArticleSlug(hash.startsWith('series/') ? hash.replace('series/', '') : null);
      } else if (hash.startsWith('product/')) {
        setCurrentPage('product');
        setActiveArticleSlug(hash.replace('product/', ''));
      } else if (hash.startsWith('creator/')) {
        setCurrentPage('creator');
        setActiveArticleSlug(hash.replace('creator/', ''));
      } else if ((hash.startsWith('topic/') || hash.startsWith('@topic/'))) {
        setCurrentPage('topic');
        setActiveArticleSlug(hash.startsWith('@topic/') ? hash.replace('@topic/', '') : hash.replace('topic/', ''));
      } else if (hash === 'creators') {
        setCurrentPage('creators');
        setActiveArticleSlug(null);
      } else if (hash === 'explore' || hash.startsWith('explore/')) {
        setCurrentPage('explore');
        setActiveArticleSlug(hash.startsWith('explore/') ? hash.replace('explore/', '') : null);
      } else if (hash === 'knowledge') {
        setCurrentPage('knowledge');
        setActiveArticleSlug(null);
      } else if (hash === 'vault') {
        setCurrentPage('vault');
        setActiveArticleSlug(null);
      } else if (hash === 'research') {
        setCurrentPage('research');
        setActiveArticleSlug(null);
      } else if (hash === 'social' || hash === 'community' || hash === 'community/new') {
        setCurrentPage('social');
        setActiveArticleSlug(hash === 'community/new' ? 'new' : null);
      } else if (hash.startsWith('question/')) {
        setActiveArticleSlug(hash.replace('question/', ''));
        setCurrentPage('question');
      } else if (hash.startsWith('community/post/')) {
        const id = hash.replace('community/post/', '');
        setActiveArticleSlug(id); // reusing activeArticleSlug state to hold param
        setCurrentPage('community_post');
      } else if (hash.startsWith('@')) {
        const username = hash.replace('@', '');
        setActiveArticleSlug(username);
        setCurrentPage('community_profile');
      } else if (hash === 'health') {
        if (checkIsAdmin(auth.currentUser?.email)) setCurrentPage('health');
        else {
          setCurrentPage('home');
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
        setActiveArticleSlug(null);
      } else if (hash === 'cms' || hash === 'admin') {
        if (canAccessCms) setCurrentPage('cms');
        else { setCurrentPage('home'); window.history.replaceState(null, '', window.location.pathname + window.location.search); }
        setActiveArticleSlug(null);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [canAccessCms]);

  const navigateTo = (page: PageView, param?: string) => {
    if (page === 'article' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('article');
      window.location.hash = `article/${param}`;
    } else if (page === 'question' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('question');
      window.location.hash = `question/${param}`;
    } else if (page === 'community_post' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('community_post');
      window.location.hash = `community/post/${param}`;
    } else if (page === 'community_profile' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('community_profile');
      window.location.hash = `@${param}`;
    } else if (page === 'series') {
      setActiveArticleSlug(param || null);
      setCurrentPage('series');
      window.location.hash = param ? `series/${param}` : 'series';
    } else if (page === 'product' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('product');
      window.location.hash = `product/${param}`;
    } else if (page === 'creator' && param) {
      setActiveArticleSlug(param);
      setCurrentPage('creator');
      window.location.hash = `creator/${param}`;
    } else if (page === 'shop') {
      setActiveArticleSlug(null); setCurrentPage('shop'); window.location.hash='shop';
    } else if (page === 'saved_products') {
      setActiveArticleSlug(null); setCurrentPage('saved_products'); window.location.hash='saved-products';
    } else if (page === 'purchases') {
      setActiveArticleSlug(null); setCurrentPage('purchases'); window.location.hash='purchases';
    } else if (page === 'knowledge') {
      setActiveArticleSlug(null); setCurrentPage('knowledge'); window.location.hash='knowledge';
    } else if (page === 'vault') {
      setActiveArticleSlug(null); setCurrentPage('vault'); window.location.hash='vault';
    } else if (page === 'research') {
      setActiveArticleSlug(null); setCurrentPage('research'); window.location.hash='research';
    } else if (page === 'learn') {
      setActiveArticleSlug(null); setCurrentPage('learn'); window.location.hash='learn';
    } else if (page === 'changelog') {
      setActiveArticleSlug(null); setCurrentPage('changelog'); window.location.hash='changelog';
    } else if (page === 'creators') {
      setActiveArticleSlug(null); setCurrentPage('creators'); window.location.hash='creators';
    } else if (page === 'explore') {
      setActiveArticleSlug(param || null);
      setCurrentPage('explore');
      window.location.hash = param ? `explore/${param.replace(/^#/, '')}` : 'explore';
    } else if (page === 'community' || page === 'social') {
      setActiveArticleSlug(param || null);
      setCurrentPage('social');
      window.location.hash = param ? `community/${param}` : 'social';
    } else {
      setActiveArticleSlug(null);
      setCurrentPage(page);
      window.location.hash = page;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleToggleSave = async (slug: string) => {
    const targetArticle = articles.find(a => a.slug === slug);
    const wasSaved = savedSlugs.includes(slug);
    const willBeSaved = !wasSaved;
    const applyLocal = (saved: boolean) => {
      setSavedSlugs(prev => {
        const next = saved ? Array.from(new Set([...prev, slug])) : prev.filter(s => s !== slug);
        try { localStorage.setItem(savedSlugsKey(userAuth?.uid), JSON.stringify(next)); } catch (e) { console.warn('LocalStorage save failed:', e); }
        return next;
      });
    };

    applyLocal(willBeSaved);
    if (!userAuth) return;
    try {
      await runSyncedOperation(() => toggleUserSaveInCloud(userAuth.uid, slug, 'article', wasSaved, targetArticle?.title || slug));
      void emitActivityEvent({ type: willBeSaved ? 'save' : 'unsave', targetId: slug, targetType: 'article', source: 'article-bookmark' }).catch(() => {});
      void recordArticleAnalyticsEvent(slug, 'bookmark', { active: willBeSaved, title: targetArticle?.title || slug }).catch((error) => console.warn('Bookmark analytics event failed:', error));
      notifyToast(willBeSaved ? 'Saved to your library.' : 'Removed from your saved items.', 'success');
    } catch (e) {
      // Do not leave the UI claiming a cloud state that failed to persist.
      applyLocal(wasSaved);
      console.error('Error saving dispatch to cloud:', e);
      notifyToast(e instanceof Error ? e.message : 'Could not sync saved state.', 'error');
    }
  };

  const handleToggleSaveCommunity = async (postId: string, title?: string) => {
    const wasSaved = savedCommunityPostIds.includes(postId);
    const willBeSaved = !wasSaved;
    const applyLocal = (saved: boolean) => {
      setSavedCommunityPostIds(prev => {
        const next = saved ? Array.from(new Set([...prev, postId])) : prev.filter(id => id !== postId);
        try { localStorage.setItem(savedCommunityKey(userAuth?.uid), JSON.stringify(next)); } catch (e) { console.warn('LocalStorage save failed for community post:', e); }
        return next;
      });
    };
    applyLocal(willBeSaved);
    if (!userAuth) return;
    try {
      await runSyncedOperation(() => toggleUserSaveInCloud(userAuth.uid, postId, 'post', wasSaved, title || 'Community Post'));
      void emitActivityEvent({ type: willBeSaved ? 'save' : 'unsave', targetId: postId, targetType: 'post', source: 'community-bookmark' }).catch(() => {});
      notifyToast(willBeSaved ? 'Saved community post.' : 'Removed from your saved items.', 'success');
    } catch (e) {
      applyLocal(wasSaved);
      console.error('Error saving community post to cloud:', e);
      notifyToast(e instanceof Error ? e.message : 'Could not sync saved state.', 'error');
    }
  };

  const handleToggleQueue = async (slug: string) => {
    if (!userAuth) {
      try { await import('./lib/firebase').then(({ loginWithGoogle }) => loginWithGoogle()); } catch (error) { console.warn('OFFSCRPT recoverable operation failed:', error); }
      return;
    }
    const queued = readingQueueIds.includes(slug);
    setReadingQueueIds(prev => queued ? prev.filter(id => id !== slug) : [...prev, slug]);
    try {
      await toggleReadingQueue(slug, 'article', articles.find(a => a.slug === slug)?.title || slug, queued);
      notifyToast(queued ? 'Removed from reading queue.' : 'Added to reading queue.', 'success');
    } catch (e) {
      console.error('Reading queue sync failed:', e);
      setReadingQueueIds(prev => queued ? [...prev, slug] : prev.filter(id => id !== slug));
    }
  };

  const handleArticlePublished = (newArticle: Article) => {
    setArticles((prev) => [newArticle, ...prev.filter((a) => a.slug !== newArticle.slug)]);
    navigateTo('article', newArticle.slug);
  };

  const handleDeleteArticle = async (slug: string) => {
    try {
      await deleteArticle(slug);
      setArticles((prev) => prev.filter((a) => a.slug !== slug));
      if (activeArticleSlug === slug) {
        navigateTo('blog');
      }
    } catch (e) {
      console.error("Failed to delete article from Firestore:", e);
    }
  };

  const handleUpdateSiteConfig = async (newConfig: SiteConfig) => {
    const previous = siteConfig;
    setSiteConfig(newConfig);
    try {
      await saveSiteConfig(newConfig);
    } catch (e) {
      setSiteConfig(previous);
      console.error('Failed to persist site config to Firestore:', e);
      notifyToast(e instanceof Error ? e.message : 'Site configuration sync failed.', 'error');
    }
  };

  const isMasterAdmin = cloudMasterAdmin || checkIsAdmin(userAuth?.email);
  const openAdminStudioForNewArticle = () => {
    if (!isMasterAdmin) return;
    setCmsEditorRequest({ mode: 'new', token: Date.now() });
    setIsCmsOpen(true);
  };

  const openAdminStudioForEditArticle = (article: Article) => {
    if (!isMasterAdmin) return;
    setCmsEditorRequest({ mode: 'edit', article, token: Date.now() });
    setIsCmsOpen(true);
  };

  const inMaintenance = !!siteConfig.maintenanceMode && !isMasterAdmin;

  const activeArticle = articles.find((a) => a.slug === activeArticleSlug);
  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsSearchOpen(false);
        setIsCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handleGlobalShortcut);
    return () => window.removeEventListener('keydown', handleGlobalShortcut);
  }, []);


  useEffect(() => {
    if (userAuth && currentPage === 'article' && activeArticle) {
      saveReadingProgress(userAuth.uid, activeArticle)
        .then(() => setContinueReadingSlug(activeArticle.slug))
        .catch((error) => console.warn('Could not save reading progress:', error));
    }
  }, [userAuth, currentPage, activeArticle?.slug]);

  return (
    <>
      <ToastHost />
    <div className="min-h-screen flex flex-col bg-white text-black font-sans selection:bg-[var(--color-primary)] selection:text-black">
      {/* Top Header */}
      <Header
        currentPage={currentPage}
        onNavigate={navigateTo}
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onOpenSiteAI={() => navigateTo('knowledge')}
        onOpenCms={canAccessCms ? () => navigateTo('cms') : undefined}
        savedCount={savedSlugs.length + savedCommunityPostIds.length}
        siteConfig={siteConfig}
        userProfile={userProfile}
        onOpenHandleModal={() => setIsHandleModalOpen(true)}
        onCreateCommunityPost={async () => {
          if (!userAuth) {
            try {
              await import('./lib/firebase').then(({ loginWithGoogle }) => loginWithGoogle());
            } catch (error) {
              console.error('Community post sign-in error:', error);
              return;
            }
          }
          navigateTo('community', 'new');
        }}
      />

      {/* Marquee Ticker */}
      <MarqueeTicker siteConfig={siteConfig} />

      {/* Main Content Area */}
      <main className="flex-1 w-full">
        <PageErrorBoundary>
        {loading ? (
          <div className="py-32 flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin text-black stroke-[3]" />
            <div className="font-display font-black text-xl uppercase tracking-wider">
              LOADING DISPATCHES...
            </div>
            <div className="font-mono text-xs text-neutral-500">
              SYNCHRONIZING {siteConfig.logoPart1}{siteConfig.logoPart2} REPOSITORY
            </div>
          </div>
        ) : currentPage === 'health' ? (
          <SystemHealthView />
        ) : currentPage === 'cms' ? (
          <AdminStudioModal
            isOpen={true}
            pageMode
            onClose={() => navigateTo('home')}
            onArticlePublished={handleArticlePublished}
            articles={articles}
            onDeleteArticle={handleDeleteArticle}
            siteConfig={siteConfig}
            onUpdateSiteConfig={handleUpdateSiteConfig}
            bentoLinks={bentoLinks}
            onUpdateBentoLinks={handleUpdateBentoLinks}
            initialArticleRequest={cmsEditorRequest}
          />
        ) : (
          <>
            {inMaintenance ? (
              <div className="max-w-3xl mx-auto px-4 py-28"><div className="border-4 border-black bg-black text-white p-8 text-center"><div className="font-mono text-[10px] text-[var(--color-primary)] font-black">OFFSCRPT MAINTENANCE</div><h1 className="font-display font-black text-4xl uppercase mt-2">BACK SOON.</h1><p className="font-mono text-sm text-neutral-300 mt-4 whitespace-pre-wrap">{siteConfig.maintenanceMessage || 'OFFSCRPT is temporarily under maintenance.'}</p></div></div>
            ) : (
            <>
            {currentPage === 'home' && (
              <HomeView
                articles={articles}
                onNavigate={navigateTo}
                onSelectArticle={(slug) => navigateTo('article', slug)}
                savedSlugs={savedSlugs}
                onToggleSave={handleToggleSave}
                onSelectCategory={(cat) => {
                  setSelectedCategory(cat);
                  navigateTo('blog');
                }}
                siteConfig={siteConfig}
                continueReadingArticle={articles.find((article) => article.slug === continueReadingSlug) || null}
                userAuth={userAuth}
              />
            )}

            {currentPage === 'blog' && (
              <BlogView
                articles={articles}
                onSelectArticle={(slug) => navigateTo('article', slug)}
                savedSlugs={savedSlugs}
                onToggleSave={handleToggleSave}
                selectedCategory={selectedCategory}
                onSelectCategory={setSelectedCategory}
                siteConfig={siteConfig}
                onNavigate={navigateTo}
                isMasterAdmin={isMasterAdmin}
                onWriteNew={openAdminStudioForNewArticle}
                onEditArticle={openAdminStudioForEditArticle}
                onDeleteArticle={handleDeleteArticle}
              />
            )}

            {currentPage === 'dashboard' && (
              <AccountDashboardView articles={articles} userProfile={userProfile} onNavigate={navigateTo} />
            )}

            {currentPage === 'shop' && <MarketplaceErrorBoundary title="Marketplace components failed to render."><MarketplaceView onNavigate={navigateTo} /></MarketplaceErrorBoundary>}

            {currentPage === 'saved_products' && <MarketplaceErrorBoundary title="Saved products could not be rendered."><SavedProductsView onNavigate={navigateTo} userProfile={userProfile} /></MarketplaceErrorBoundary>}

            {currentPage === 'purchases' && (
              <PurchasesView onNavigate={navigateTo} />
            )}

            {currentPage === 'activity' && (
              <ActivityCenterView articles={articles} userProfile={userProfile} onNavigate={navigateTo} />
            )}

            {currentPage === 'creator_studio' && (
              <CreatorDashboardView articles={articles} userProfile={userProfile} onNavigate={navigateTo} />
            )}

            {currentPage === 'preferences' && (
              <PreferencesView onNavigate={navigateTo} />
            )}

            {currentPage === 'article' && (
              activeArticle ? (
                <ArticleView
                  article={activeArticle}
                  allArticles={articles}
                  onBack={() => navigateTo('blog')}
                  onSelectArticle={(slug) => navigateTo('article', slug)}
                  onOpenSeries={(seriesId) => navigateTo('series', seriesId)}
                  onViewAllSeries={() => navigateTo('series')}
                  onOpenAuthorProfile={(username) => navigateTo('community_profile', username)}
                  onOpenDiscussion={(id) => navigateTo('community_post', id)}
                  isSaved={savedSlugs.includes(activeArticle.slug)}
                  onToggleSave={handleToggleSave}
                  isQueued={readingQueueIds.includes(activeArticle.slug)}
                  onToggleQueue={handleToggleQueue}
                  siteConfig={siteConfig}
                />
              ) : (
                <div className="max-w-xl mx-auto py-24 px-4 text-center space-y-6">
                  <div className="w-16 h-16 bg-[var(--color-accent)] neo-border neo-shadow mx-auto flex items-center justify-center font-display font-black text-2xl">
                    404
                  </div>
                  <h2 className="font-display font-black text-3xl uppercase tracking-tight">
                    ESSAY NOT FOUND
                  </h2>
                  <p className="font-sans text-neutral-600">
                    The requested dispatch slug "{activeArticleSlug}" could not be located in the current repository.
                  </p>
                  <button
                    onClick={() => navigateTo('blog')}
                    className="px-6 py-3 bg-[var(--color-primary)] text-black font-display font-black text-sm uppercase neo-border neo-shadow-sm hover:bg-black hover:text-[var(--color-primary)] active:translate-x-1 active:translate-y-1 active:shadow-none transition-all"
                  >
                    RETURN TO ARCHIVE
                  </button>
                </div>
              )
            )}

            {currentPage === 'about' && (
              <AboutView onNavigate={navigateTo} siteConfig={siteConfig} />
            )}

            {currentPage === 'saved' && (
              <SavedView 
                savedSlugs={savedSlugs} 
                savedCommunityPostIds={savedCommunityPostIds}
                articles={articles} 
                onNavigate={navigateTo} 
                onToggleSaveArticle={handleToggleSave} 
                onToggleSaveCommunityPost={handleToggleSaveCommunity}
                userAuth={userAuth}
                userProfile={userProfile}
                siteConfig={siteConfig}
              />
            )}

            {currentPage === 'history' && <HistoryView onNavigate={navigateTo} />}

            {currentPage === 'notifications' && (
              <NotificationsView userProfile={userProfile} onNavigate={navigateTo} />
            )}

            {currentPage === 'social' && (
              <SocialHubView userProfile={userProfile} onNavigate={navigateTo} siteConfig={siteConfig} />
            )}
            {currentPage === 'knowledge' && <KnowledgeView articles={articles} userProfile={userProfile} onNavigate={navigateTo} mode="knowledge" />}
            {currentPage === 'vault' && <KnowledgeView articles={articles} userProfile={userProfile} onNavigate={navigateTo} mode="vault" />}
            {currentPage === 'research' && <KnowledgeView articles={articles} userProfile={userProfile} onNavigate={navigateTo} mode="research" />}
            {currentPage === 'learn' && <LearnView />}
            {currentPage === 'question' && activeArticleSlug && (
              <QuestionView questionId={activeArticleSlug} userProfile={userProfile} onNavigate={navigateTo} />
            )}
            {currentPage === 'creators' && (
              <CreatorDiscoveryView articles={articles} onNavigate={navigateTo} />
            )}

            {currentPage === 'explore' && (
              <ExploreView articles={articles} userAuth={userAuth} userProfile={userProfile} onNavigate={navigateTo} initialHashtag={activeArticleSlug || ''} />
            )}

            {currentPage === 'series' && (
              <SeriesView articles={articles} onNavigate={navigateTo} selectedSeriesId={activeArticleSlug} />
            )}

            {currentPage === 'creator' && activeArticleSlug && (
              <CreatorView username={activeArticleSlug} articles={articles} currentUserUid={userAuth?.uid} currentUsername={userProfile?.username} onNavigate={navigateTo} />
            )}

            {currentPage === 'product' && activeArticleSlug && (
              <MarketplaceErrorBoundary title="Product page components failed to render.">
                <CommerceProductView productId={activeArticleSlug} userProfile={userProfile} onNavigate={navigateTo} />
              </MarketplaceErrorBoundary>
            )}

            {currentPage === 'topic' && activeArticleSlug && (
              <TopicView slug={activeArticleSlug} articles={articles} onNavigate={navigateTo} />
            )}

            {currentPage === 'community' && (
              <CommunityView 
                onNavigate={navigateTo}
                userProfile={userProfile}
                onOpenHandleModal={() => setIsHandleModalOpen(true)}
                savedCommunityPostIds={savedCommunityPostIds}
                onToggleSaveCommunityPost={handleToggleSaveCommunity}
                onProfileUpdated={(p) => setUserProfile(p)}
                autoOpenComposer={activeArticleSlug === 'new'}
              />
            )}
            
            {currentPage === 'community_post' && activeArticleSlug && (
              <CommunityPostView 
                postId={activeArticleSlug} 
                onNavigate={navigateTo} 
                isSaved={savedCommunityPostIds.includes(activeArticleSlug)}
                onToggleSave={(id, title) => handleToggleSaveCommunity(id, title)}
              />
            )}
            
            {currentPage === 'community_profile' && activeArticleSlug && (
              <CommunityProfileView 
                username={activeArticleSlug} 
                onNavigate={navigateTo} 
                currentUserProfile={userProfile} 
                onProfileUpdated={(p) => { setUserProfile(p); setIsHandleModalOpen(false); }}
              />
            )}

            {currentPage === 'links' && (
              <LinksView links={bentoLinks} siteConfig={siteConfig} />
            )}

            {currentPage === 'contact' && (
              <ContactView siteConfig={siteConfig} />
            )}

            {currentPage === 'changelog' && (
              <ChangelogView onNavigate={navigateTo} currentPage={currentPage} />
            )}
              </>
            )}
          </>
        )}
        </PageErrorBoundary>
      </main>

      {/* Global Modals */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onOpenSearch={() => setIsSearchOpen(true)}
        onNavigate={navigateTo}
        onOpenSiteAI={() => navigateTo('knowledge')}
        onCreatePost={async () => {
          if (!userAuth) { try { await import('./lib/firebase').then(({ loginWithGoogle }) => loginWithGoogle()); } catch { return; } }
          navigateTo('community', 'new');
        }}
      />

      <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        articles={articles}
        onSelectArticle={(slug) => navigateTo('article', slug)}
        onNavigate={navigateTo}
        siteConfig={siteConfig}
      />

      <AdminStudioModal
        isOpen={isCmsOpen && currentPage !== 'cms'}
        onClose={() => {
          setIsCmsOpen(false);
          if (currentPage === 'cms') {
            navigateTo('home');
          }
        }}
        onArticlePublished={handleArticlePublished}
        articles={articles}
        onDeleteArticle={handleDeleteArticle}
        siteConfig={siteConfig}
        onUpdateSiteConfig={handleUpdateSiteConfig}
        bentoLinks={bentoLinks}
        onUpdateBentoLinks={handleUpdateBentoLinks}
        initialArticleRequest={cmsEditorRequest}
      />

      <RssModal
        isOpen={isRssOpen}
        onClose={() => setIsRssOpen(false)}
        articles={articles}
        siteConfig={siteConfig}
      />

      <UniqueHandleModal
        isOpen={isHandleModalOpen}
        onClose={() => setIsHandleModalOpen(false)}
        currentUser={userAuth}
        onProfileCreated={(profile) => {
          setUserProfile(profile);
          setIsHandleModalOpen(false);
        }}
      />

      <SiteAnnouncementPopup siteConfig={siteConfig} currentPage={currentPage} onNavigate={navigateTo} />

      {/* Footer */}
      <Footer
        onNavigate={navigateTo}
        onOpenCms={canAccessCms ? () => navigateTo('cms') : undefined}
        onOpenRssModal={() => setIsRssOpen(true)}
        siteConfig={siteConfig}
        articles={articles}
      />
    </div>
    </>
  );
}
