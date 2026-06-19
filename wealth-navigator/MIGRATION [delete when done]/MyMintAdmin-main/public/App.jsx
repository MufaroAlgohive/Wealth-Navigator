import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense, startTransition } from "react";
import { supabase } from "./lib/supabase.js";
import { getMarketsSecuritiesWithMetrics } from "./lib/marketData.js";
import { setCachedSession, clearSessionCache } from "./lib/sessionCache.js";
import { clearAllUserCaches } from "./lib/userCacheReset.js";
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import SwipeBackWrapper from "./components/SwipeBackWrapper.jsx";
import AppLayout from "./layouts/AppLayout.jsx";
import { useProfile } from "./lib/useProfile";
import { NotificationsProvider, createWelcomeNotification, useNotificationsContext } from "./lib/NotificationsContext.jsx";
import HomePage from "./pages/HomePage.jsx";
import ChildInvestModal from "./components/ChildInvestModal.jsx";
const CreditHome = lazy(() => import("./pages/credit/CreditHome"));
const NewPortfolioPage = lazy(() => import("./pages/NewPortfolioPage.jsx"));
const MarketsPage = lazy(() => import("./pages/MarketsPage.jsx"));
const MorePage = lazy(() => import("./pages/MorePage.jsx"));

const AuthPage = lazy(() => import("./pages/AuthPage.jsx"));
const CreditApplyPage = lazy(() => import("./pages/CreditApplyPage.jsx"));
const UnsecuredCreditDashboard = lazy(() => import("./pages/credit/UnsecuredCreditDashboard.jsx"));
const CreditRepayPage = lazy(() => import("./pages/CreditRepayPage.jsx"));
const InvestmentsPage = lazy(() => import("./pages/InvestmentsPage.jsx"));
const InvestPage = lazy(() => import("./pages/InvestPage.jsx"));
const InvestAmountPage = lazy(() => import("./pages/InvestAmountPage.jsx"));
const PaymentPage = lazy(() => import("./pages/PaymentPage.jsx"));
const PaymentSuccessPage = lazy(() => import("./pages/PaymentSuccessPage.jsx"));
const PaymentPendingPage = lazy(() => import("./pages/PaymentPendingPage.jsx"));
const PaymentMethodModal = lazy(() => import("./components/PaymentMethodModal.jsx"));
const FactsheetPage = lazy(() => import("./pages/FactsheetPage.jsx"));
const OpenStrategiesPage = lazy(() => import("./pages/OpenStrategiesPage.jsx"));
const ManageSubscriptionsPage = lazy(() => import("./pages/ManageSubscriptionsPage.jsx"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage.jsx"));
const InstantLiquidityPage = lazy(() => import("./pages/credit/InstantLiquidity.jsx"));
const CreditHowItWorksPage = lazy(() => import("./pages/credit/CreditHowItWorks.jsx"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.jsx"));
const TransactPage = lazy(() => import("./pages/TransactPage.jsx"));
const UserOnboardingPage = lazy(() => import("./pages/UserOnboardingPage.jsx"));
const BiometricsDebugPage = lazy(() => import("./pages/BiometricsDebugPage.jsx"));
const EditProfilePage = lazy(() => import("./pages/EditProfilePage.jsx"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage.jsx"));
const NotificationSettingsPage = lazy(() => import("./pages/NotificationSettingsPage.jsx"));
const MintBalancePage = lazy(() => import("./pages/MintBalancePage.jsx"));
const StockDetailPage = lazy(() => import("./pages/StockDetailPage.jsx"));
const StockBuyPage = lazy(() => import("./pages/StockBuyPage.jsx"));
const GiftCodeEntryPage = lazy(() => import("./pages/GiftCodeEntryPage.jsx"));
const GiftPreviewPage = lazy(() => import("./pages/GiftPreviewPage.jsx"));
const SentGiftsPageV2 = lazy(() => import("./pages/SentGiftsPageV2.jsx"));
const GiftStrategyPickerPage = lazy(() => import("./pages/GiftStrategyPickerPage.jsx"));
const NewsArticlePage = lazy(() => import("./pages/NewsArticlePage.jsx"));
const ActivityPage = lazy(() => import("./pages/ActivityPage.jsx"));
const ActionsPage = lazy(() => import("./pages/ActionsPage.jsx"));
const ProfileDetailsPage = lazy(() => import("./pages/ProfileDetailsPage.jsx"));
const ChangePasswordPage = lazy(() => import("./pages/ChangePasswordPage.jsx"));
const LegalDocumentationPage = lazy(() => import("./pages/LegalDocumentationPage.jsx"));
const StatementsPage = lazy(() => import("./pages/StatementsPage.jsx"));
const DepositPage = lazy(() => import("./pages/DepositPage.jsx"));
const IdentityCheckPage = lazy(() => import("./pages/IdentityCheckPage.jsx"));
const BankLinkPage = lazy(() => import("./pages/BankLinkPage.jsx"));
const MintBankPage = lazy(() => import("./pages/MintBankPage.jsx"));
const InvitePage = lazy(() => import("./pages/InvitePage.jsx"));
const ActiveSessionsPage = lazy(() => import("./pages/ActiveSessionsPage.jsx"));
const PinSetupPage = lazy(() => import("./pages/PinSetupPage.jsx"));
const FamilyDashboardPage = lazy(() => import("./pages/FamilyDashboardPage.jsx"));
const ChildDashboardPage = lazy(() => import("./pages/ChildDashboardPage.jsx"));
const FuneralCoverPage = lazy(() => import("./pages/FuneralCoverPage.jsx"));
import { useInactivityTimeout } from "./lib/useInactivityTimeout.jsx";
import PinLockScreen from "./components/PinLockScreen.jsx";
import { isPinEnabled } from "./lib/usePin.js";
import GoalLinkModal from "./components/GoalLinkModal.jsx";
import KidStrategyChildPickerModal from "./components/KidStrategyChildPickerModal.jsx";
import { useOnboardingStatus } from "./lib/useOnboardingStatus.js";
import { checkOnboardingComplete } from "./lib/checkOnboardingComplete.js";
import MaintenanceModal from "./components/MaintenanceModal.jsx";
import HomeSkeleton from "./components/HomeSkeleton.jsx";
import GiftReceivedPopup from "./components/GiftReceivedPopup.jsx";

const PERSISTENT_KEYS = [
  'mint_device_id',
  'mint_theme',
  'mint_language',
  'mint_onboarding_completed'
];

const clearUserStorage = () => {
  const keysToKeep = {};
  PERSISTENT_KEYS.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) keysToKeep[key] = value;
  });

  localStorage.clear();

  Object.entries(keysToKeep).forEach(([key, value]) => {
    localStorage.setItem(key, value);
  });

  sessionStorage.clear();
};

const initialHash = window.location.hash;
const isRecoveryMode = initialHash.includes('type=recovery');

// Detect /gift/claim/:token deep link
const initialGiftToken = (() => {
  const match = window.location.pathname.match(/^\/gift\/claim\/([a-f0-9]+)$/i);
  return match ? match[1] : null;
})();

const getHashParams = (hash) => {
  if (!hash) return {};
  return Object.fromEntries(new URLSearchParams(hash.substring(1)));
};

const hashParams = getHashParams(initialHash);
const hasError = hashParams.error === 'access_denied';
const errorCode = hashParams.error_code;

// Synchronous localStorage session check — runs at module load, before any render.
// If a valid non-expired Supabase token is cached, we skip isCheckingAuth entirely
// and jump straight to 'home', giving an instant startup with no loading screen.
const getStoredSession = () => {
  if (hasError || isRecoveryMode) return null;
  try {
    const key = Object.keys(localStorage).find(
      k => k.startsWith('sb-') && k.endsWith('-auth-token')
    );
    if (!key) return null;
    const stored = JSON.parse(localStorage.getItem(key));
    if (stored?.access_token && stored?.expires_at && Date.now() / 1000 < stored.expires_at) {
      return stored;
    }
  } catch {}
  return null;
};
const storedSession = getStoredSession();

const getTokensFromHash = (hash) => {
  if (!hash) return null;
  const params = new URLSearchParams(hash.substring(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken) {
    return { accessToken, refreshToken: refreshToken || accessToken };
  }
  return null;
};

const recoveryTokens = isRecoveryMode ? getTokensFromHash(initialHash) : null;

const mainTabs = ['home', 'credit', 'transact', 'investments', 'markets', 'news', 'deposit', 'more', 'welcome', 'auth'];

const App = () => {
  const initialPage = hasError ? "linkExpired" : initialGiftToken ? "giftClaim" : (isRecoveryMode ? "auth" : (storedSession ? "home" : "welcome"));
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [mountedTabs, setMountedTabs] = useState(() => {
    const initial = new Set(['home']);
    if (mainTabs.includes(initialPage)) initial.add(initialPage);
    return initial;
  });
  const [giftToken, setGiftToken] = useState(initialGiftToken);
  const [giftPreviewData, setGiftPreviewData] = useState(null);
  const [pageParams, setPageParams] = useState(null);
  const [previousPageName, setPreviousPageName] = useState(null);
  const [authStep, setAuthStep] = useState(isRecoveryMode ? "newPassword" : "email");
  const [isCheckingAuth, setIsCheckingAuth] = useState(!storedSession && !hasError);
  const [sessionReady, setSessionReady] = useState(false);
  const [notificationReturnPage, setNotificationReturnPage] = useState("home");
  const [modal, setModal] = useState(null);
  const [selectedSecurity, setSelectedSecurity] = useState(null);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [selectedArticleId, setSelectedArticleId] = useState(null);
  const [selectedFamilyChild, setSelectedFamilyChild] = useState(null);
  const [funeralCoverInitialDependents, setFuneralCoverInitialDependents] = useState([]);
  const [marketsInitialView, setMarketsInitialView] = useState(null);
  const [portfolioDeepLink, setPortfolioDeepLink] = useState(null);
  const [investmentAmount, setInvestmentAmount] = useState(0);
  const [baseInvestmentAmount, setBaseInvestmentAmount] = useState(0);
  const [investmentFees, setInvestmentFees] = useState(null);
  const [stockCheckout, setStockCheckout] = useState({ security: null, amount: 0, baseAmount: 0 });
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [showChildPickerModal, setShowChildPickerModal] = useState(false);
  const [showChildInvestModal, setShowChildInvestModal] = useState(false);
  const [selectedChildForInvest, setSelectedChildForInvest] = useState(null);
  const [marketsChildFilter, setMarketsChildFilter] = useState(null);
  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState(null);
  const [pendingPaymentInfo, setPendingPaymentInfo] = useState(null);
  const [pendingGoalFlow, setPendingGoalFlow] = useState(null);
  const [selectedGoalId, setSelectedGoalId] = useState(null);
  const selectedGoalIdRef = useRef(null);
  const goalInvestAmountRef = useRef(0);
  const pendingPaymentTypeRef = useRef(null);
  const recoveryHandled = useRef(false);
  const { refetch: refetchNotifications, reset: resetNotifications } = useNotificationsContext();
  const [showPinLock, setShowPinLock] = useState(false);
  const [showOpenStrategiesMaintenance, setShowOpenStrategiesMaintenance] = useState(false);

  const isAuthenticated = !['welcome', 'auth', 'linkExpired'].includes(currentPage);
  const { profile, loading: profileLoading } = useProfile({ enabled: isAuthenticated });
  const { onboardingComplete, loading: onboardingLoading } = useOnboardingStatus({ enabled: isAuthenticated });
  const onboardingRef = useRef({ complete: false, loading: true });

  useEffect(() => {
    onboardingRef.current = { complete: onboardingComplete, loading: onboardingLoading };
  }, [onboardingComplete, onboardingLoading]);

  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  useInactivityTimeout({
    enabled: isAuthenticated,
    onLogout: () => {
      if (supabase) supabase.auth.signOut({ scope: 'local' });
      sessionStorage.removeItem('mint_pin_unlocked');
      setShowPinLock(false);
      setCurrentPage("welcome");
    },
  });

  const justLoggedInRef = useRef(false);
  const intentionalLogoutRef = useRef(false);
  const lastAuthUserIdRef = useRef(null);

  const handleBeforeLogout = () => {
    intentionalLogoutRef.current = true;
  };
  // Read ozow param synchronously at init — before any effect can clear the URL
  const ozowReturnParam = useRef(new URLSearchParams(window.location.search).get("ozow"));
  const ozowRecordedRef = useRef(false);

  useEffect(() => {
    if (ozowReturnParam.current) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (currentPage !== "paymentSuccess" || ozowRecordedRef.current) return;
    const pending = sessionStorage.getItem("ozow_pending");
    if (!pending) return;
    let parsed;
    try { parsed = JSON.parse(pending); } catch { return; }
    if (!parsed?.transactionRef || !parsed?.strategyId || !parsed?.amount) return;
    ozowRecordedRef.current = true;
    sessionStorage.removeItem("ozow_pending");
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const resp = await fetch("/api/ozow/record-success", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            transactionRef: parsed.transactionRef,
            strategyId: parsed.strategyId,
            amount: parsed.amount,
          }),
        });
        const result = await resp.json();
        if (result.success) {
          console.log("[ozow] Investment recorded from success page", result.alreadyRecorded ? "(already done)" : "");
        } else {
          console.error("[ozow] record-success failed:", result.error);
        }
      } catch (err) {
        console.error("[ozow] record-success error:", err);
      }
    })();
  }, [currentPage]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        localStorage.setItem('mint_app_hidden_at', Date.now().toString());
      } else {
        if (justLoggedInRef.current) return;
        const hiddenAt = localStorage.getItem('mint_app_hidden_at');
        if (hiddenAt) {
          const elapsed = Date.now() - parseInt(hiddenAt, 10);
          const FOUR_MINUTES = 4 * 60 * 1000;
          if (elapsed >= FOUR_MINUTES && isAuthenticated && !isCheckingAuth) {
            if (isPinEnabled()) {
              sessionStorage.removeItem('mint_pin_unlocked');
              setShowPinLock(true);
            } else {
              if (supabase) supabase.auth.signOut({ scope: 'local' });
              sessionStorage.removeItem('mint_pin_unlocked');
              setShowPinLock(false);
              setCurrentPage("welcome");
            }
          }
          localStorage.removeItem('mint_app_hidden_at');
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated, isCheckingAuth]);

  const navigationHistory = useRef([]);
  const pageStateCache = useRef({});

  const cacheCurrentPageState = useCallback(() => {
    pageStateCache.current[currentPage] = {
      selectedSecurity,
      selectedStrategy,
      selectedArticleId,
      investmentAmount,
      stockCheckout,
      notificationReturnPage,
    };
  }, [currentPage, selectedSecurity, selectedStrategy, selectedArticleId, investmentAmount, stockCheckout, notificationReturnPage]);

  const pendingProgrammaticBacks = useRef(0);

  const navigateTo = useCallback((page) => {
    if (page === currentPage) return;

    // Protected routes that REQUIRE onboarding
    const protectedPages = ["deposit", "creditApply", "creditRepay"];


    if (protectedPages.includes(page) && !onboardingRef.current.loading && !onboardingRef.current.complete) {
      console.log(`[App] Onboarding required for page: ${page}. Redirecting.`);
      setCurrentPage("userOnboarding"); // Redirect to the actual onboarding flow
      return;
    }

    if (!mainTabs.includes(page)) {
      cacheCurrentPageState();
      navigationHistory.current.push(currentPage);
      if (navigationHistory.current.length > 20) {
        navigationHistory.current = navigationHistory.current.slice(-20);
      }
      setPreviousPageName(currentPage);

      if (!Capacitor.isNativePlatform()) {
        window.history.pushState({ mintPage: page }, '');
      }
    } else {
      navigationHistory.current = [];
      setPreviousPageName(null);
      setMountedTabs(prev => prev.has(page) ? prev : new Set([...prev, page]));
    }

    startTransition(() => setCurrentPage(page));
  }, [currentPage, cacheCurrentPageState, onboardingComplete]);

  const handleTabChange = useCallback((tab) => {
    navigationHistory.current = [];
    setPreviousPageName(null);
    if (tab !== 'markets') {
      setMarketsChildFilter(null);
      setSelectedChildForInvest(null);
    }
    setMountedTabs(prev => prev.has(tab) ? prev : new Set([...prev, tab]));
    startTransition(() => setCurrentPage(tab));
  }, []);

  const goBack = useCallback(() => {
    if (navigationHistory.current.length > 0) {
      const prevPage = navigationHistory.current.pop();
      const newPreviousPage = navigationHistory.current.length > 0
        ? navigationHistory.current[navigationHistory.current.length - 1]
        : null;
      setPreviousPageName(newPreviousPage);
      startTransition(() => setCurrentPage(prevPage));

      if (!Capacitor.isNativePlatform()) {
        pendingProgrammaticBacks.current++;
        window.history.back();
      }
      return true;
    }

    if (!mainTabs.includes(currentPage)) {
      setPreviousPageName(null);
      startTransition(() => setCurrentPage('home'));

      if (!Capacitor.isNativePlatform()) {
        pendingProgrammaticBacks.current++;
        window.history.back();
      }
      return true;
    }

    return false;
  }, [currentPage]);

  const canSwipeBack = !mainTabs.includes(currentPage);

  const lastBackPressRef = useRef(0);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return;
    }

    const handleBackButton = () => {
      if (navigationHistory.current.length > 0) {
        const prevPage = navigationHistory.current.pop();
        const newPreviousPage = navigationHistory.current.length > 0
          ? navigationHistory.current[navigationHistory.current.length - 1]
          : null;
        setPreviousPageName(newPreviousPage);
        setCurrentPage(prevPage);
        return;
      }

      if (!mainTabs.includes(currentPage)) {
        setPreviousPageName(null);
        setCurrentPage('home');
        return;
      }

      const now = Date.now();
      if (now - lastBackPressRef.current < 2000) {
        CapacitorApp.exitApp();
      } else {
        lastBackPressRef.current = now;
      }
    };

    const listener = CapacitorApp.addListener('backButton', handleBackButton);

    return () => {
      listener.then(l => l.remove());
    };
  }, [currentPage]);

  useEffect(() => {
    const handleNavigationEvent = (e) => {
      const { page, member, child } = e.detail || {};
      if (page) {
        let normalizedPage = page === 'family' ? 'familyDashboard' : page;
        const selectedChild = child || member || null;
        if (selectedChild && (page === 'childDashboard' || page === 'memberPortfolio')) {
          setSelectedFamilyChild(selectedChild);
          normalizedPage = 'childDashboard';
        }
        if (page === 'marketsChildInvest' && selectedChild) {
          setMarketsChildFilter(selectedChild);
          setSelectedChildForInvest(selectedChild);
          normalizedPage = 'markets';
        } else if (page !== 'markets') {
          setMarketsChildFilter(null);
        }
        if (page === 'userOnboarding') {
          setNotificationReturnPage(currentPage);
        }
        navigateTo(normalizedPage);
      }
    };

    window.addEventListener('navigate-within-app', handleNavigationEvent);
    return () => window.removeEventListener('navigate-within-app', handleNavigationEvent);
  }, [navigateTo, currentPage]);

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;

    window.history.replaceState({ mintPage: 'root' }, '');

    const handlePopState = () => {
      if (pendingProgrammaticBacks.current > 0) {
        pendingProgrammaticBacks.current--;
        return;
      }

      if (navigationHistory.current.length > 0) {
        const prevPage = navigationHistory.current.pop();
        const newPreviousPage = navigationHistory.current.length > 0
          ? navigationHistory.current[navigationHistory.current.length - 1]
          : null;
        setPreviousPageName(newPreviousPage);
        setCurrentPage(prevPage);
      } else if (!mainTabs.includes(currentPageRef.current)) {
        setPreviousPageName(null);
        setCurrentPage('home');
      } else {
        window.history.pushState({ mintPage: 'root' }, '');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const appContent = document.querySelector(".app-content");
      if (appContent) {
        appContent.scrollTo({ top: 0, left: 0 });
      }
      window.scrollTo({ top: 0, left: 0 });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [currentPage]);

  useEffect(() => {
    if (hasError) {
      window.history.replaceState({}, document.title, window.location.pathname);
      setIsCheckingAuth(false);
      return;
    }

    const setupRecoverySession = async () => {
      if (isRecoveryMode && recoveryTokens && supabase) {
        try {
          const { error } = await supabase.auth.setSession({
            access_token: recoveryTokens.accessToken,
            refresh_token: recoveryTokens.refreshToken
          });

          if (!error) {
            setSessionReady(true);
          }
        } catch (err) {
          console.error('Error setting recovery session:', err);
        }
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      setIsCheckingAuth(false);
    };

    const checkExistingSession = async () => {
      // Safety timeout: never block on the skeleton for more than 300ms.
      // Supabase auth lock can deadlock for 5s+ in React StrictMode causing
      // the spinner to hang indefinitely. The timeout ensures the UI always
      // unblocks; the session check still completes in the background.
      const safetyTimer = setTimeout(() => setIsCheckingAuth(false), window.location.hash.includes('access_token') ? 5000 : 300);

      if (supabase && !isRecoveryMode && !hasError) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          clearTimeout(safetyTimer);
          if (session) {
            if (ozowReturnParam.current === "success") {
              setCurrentPage("paymentSuccess");
            } else {
              setCurrentPage("home");
            }
            const alreadyUnlocked = sessionStorage.getItem('mint_pin_unlocked') === 'true';
            if (isPinEnabled() && !alreadyUnlocked) {
              setShowPinLock(true);
            }
          }
        } catch (err) {
          clearTimeout(safetyTimer);
          console.error("Session check error:", err);
        }
      } else {
        clearTimeout(safetyTimer);
      }
      setIsCheckingAuth(false);
    };

    if (isRecoveryMode) {
      setupRecoverySession();
    } else {
      checkExistingSession();
    }
  }, []);

  useEffect(() => {
    if (!supabase || isRecoveryMode) {
      return;
    }

    const handleRecoveryFlow = () => {
      if (recoveryHandled.current) return;
      recoveryHandled.current = true;
      setAuthStep("newPassword");
      setCurrentPage("auth");
      window.history.replaceState({}, document.title, window.location.pathname);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        handleRecoveryFlow();
      }
      if (event === 'SIGNED_OUT') {
        clearAllUserCaches();
        clearUserStorage();
        if (resetNotifications) resetNotifications();

        // Intentional logout (user clicked "Log out") — skip session-expired overlay
        if (intentionalLogoutRef.current) {
          intentionalLogoutRef.current = false;
          sessionExpiredPageRef.current = null;
          setShowPinLock(false);
          return;
        }

        // Don't force navigate - let SessionExpired overlay handle UX gracefully
        // This prevents jarring redirects and shows users why they were logged out

        if (justLoggedInRef.current || Date.now() < sessionCheckSkipUntilRef.current) {
          return;
        }
        if (['welcome', 'auth', 'linkExpired'].includes(currentPageRef.current)) {
          return;
        }
        sessionExpiredPageRef.current = currentPageRef.current;
        setShowSessionExpired(true);
        setShowPinLock(false);
      }
      if (event === 'TOKEN_REFRESHED' && session) {
        setCachedSession(session);
        setSessionReady(true);
      }
      if (event === 'SIGNED_IN' && session) {
        setCachedSession(session);
        // If a different user just logged in, nuke all stale caches immediately
        // so they never see the previous user's data
        const incomingId = session.user?.id;
        if (incomingId && incomingId !== lastAuthUserIdRef.current) {
          clearAllUserCaches();
        }
        lastAuthUserIdRef.current = incomingId || null;
        // Handle magic-link / hash-token sign-ins: the normal login UI callbacks
        // (handleLoginComplete) are never called in this path, so navigate here.
        if (['welcome', 'auth', 'linkExpired'].includes(currentPageRef.current) && !justLoggedInRef.current) {
          setCurrentPage('home');
          setIsCheckingAuth(false);
        }
      }
      if (event === 'SIGNED_OUT') {
        clearSessionCache();
        lastAuthUserIdRef.current = null;
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  const [showSessionExpired, setShowSessionExpired] = useState(false);
  const sessionExpiredPageRef = useRef(null);

  const sessionCheckSkipUntilRef = useRef(0);


  useEffect(() => {
    if (!supabase || !isAuthenticated) return;

    const checkSession = async () => {
      if (justLoggedInRef.current) return;
      if (Date.now() < sessionCheckSkipUntilRef.current) return;
      if (document.hidden) return;

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          // Silently try to refresh — if it succeeds great, if not we wait for
          // onAuthStateChange(SIGNED_OUT) to show the expired screen.
          await supabase.auth.refreshSession();
          return;
        }
        const fingerprint = localStorage.getItem('mint_session_fingerprint');
        if (fingerprint && session?.access_token) {
          try {
            const res = await fetch(`/api/sessions/validate?fingerprint=${encodeURIComponent(fingerprint)}`, {
              headers: { Authorization: `Bearer ${session.access_token}` },
            });
            if (res.ok) {
              const json = await res.json();
              if (json.success && json.valid === false) {
                console.log('[session-check] Session revoked remotely');
                await supabase.auth.signOut({ scope: 'local' });
                setShowPinLock(false);
                setCurrentPage("welcome");
                return;
              }
            }
          } catch (valErr) {
            // ignore validation errors
          }
        }
      } catch (err) {
        console.error('[session-check] Error:', err);
      }
    };

    const initialDelay = setTimeout(() => checkSession(), 60000);
    const interval = setInterval(checkSession, 120000);

    return () => {
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  // Prefetch lazily-loaded chunks that users commonly navigate to, so the first
  // tap feels instant rather than waiting for the JS chunk to download.
  // Also pre-warms the markets securities cache so the Markets tab feels instant.
  useEffect(() => {
    if (!isAuthenticated) return;
    const prefetch = () => {
      import("./pages/FactsheetPage.jsx");
      import("./pages/InvestAmountPage.jsx");
      import("./pages/InvestPage.jsx");
      import("./pages/PaymentPage.jsx");
      import("./pages/PaymentSuccessPage.jsx");
      // Fire-and-forget: warm the markets data cache before the user navigates there
      getMarketsSecuritiesWithMetrics().catch(() => {});
    };
    const schedule = window.requestIdleCallback
      ? () => window.requestIdleCallback(prefetch, { timeout: 3000 })
      : () => setTimeout(prefetch, 1500);
    const t = setTimeout(schedule, 3000);
    return () => clearTimeout(t);
  }, [isAuthenticated]);

  const openAuthFlow = (step) => {
    setAuthStep(step);
    setCurrentPage("auth");
  };

  const openModal = (title, message) => {
    setModal({ title, message });
  };

  const closeModal = () => {
    setModal(null);
  };

  const handleWithdrawRequest = async () => {
    try {
      if (!supabase) {
        openModal("Withdraw", "You don't have any allocations to withdraw from.");
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user) {
        openModal("Withdraw", "You don't have any allocations to withdraw from.");
        return;
      }

      const { count, error } = await supabase
        .from("stock_holdings")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userData.user.id)
        .eq("is_active", true);

      if (error || !count) {
        openModal("Withdraw", "You don't have any allocations to withdraw from.");
        return;
      }

      openModal("Withdraw", "Withdrawals are coming soon.");
    } catch (err) {
      console.error("Failed to check allocations", err);
      openModal("Withdraw", "You don't have any allocations to withdraw from.");
    }
  };

  const handleShowComingSoon = (label) => {
    openModal(label, "Coming soon.");
  };

  const renderPageContent = useCallback((pageName, isPreview = false) => {
    const cachedState = pageStateCache.current[pageName] || {};
    const previewSecurity = isPreview ? (cachedState.selectedSecurity || selectedSecurity) : selectedSecurity;
    const previewStrategy = isPreview ? (cachedState.selectedStrategy || selectedStrategy) : selectedStrategy;
    const previewArticleId = isPreview ? (cachedState.selectedArticleId || selectedArticleId) : selectedArticleId;

    const noOp = () => { };

    switch (pageName) {
      case 'home':
        return (
          <AppLayout
            activeTab="home"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <HomePage
              onOpenNotifications={noOp}
              onOpenMintBalance={noOp}
              onOpenActivity={noOp}
              onOpenActions={noOp}
              onOpenInvestments={noOp}
              onOpenCredit={noOp}
              onOpenCreditApply={noOp}
              onOpenCreditRepay={noOp}
              onOpenInvest={noOp}
              onOpenWithdraw={noOp}
              onOpenSettings={noOp}
              onOpenFamily={() => navigateTo("familyDashboard")}
              onSelectMember={(child) => { setSelectedFamilyChild(child); navigateTo("childDashboard"); }}
              onOpenInsure={() => navigateTo("funeralCover")}
            />
          </AppLayout>
        );
      case "credit":
        return (
          <CreditHome
            profile={profile}
            onOpenNotifications={() => setShowNotifications(true)}
            onTabChange={setCurrentPage}
          />
        );
      case 'statements':
        return (
          <AppLayout
            activeTab="statements"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <StatementsPage onOpenNotifications={noOp} />
          </AppLayout>
        );
      case 'investments':
        return (
          <AppLayout
            activeTab="investments"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <NewPortfolioPage
              onBack={noOp}
              onOpenNotifications={noOp}
              onOpenInvest={noOp}
              onOpenStrategies={noOp}
            />
          </AppLayout>
        );

      case 'instantLiquidity':
        return (
          <AppLayout
            activeTab="credit" // Keeps the credit tab highlighted in the layout
            onTabChange={handleTabChange}
            onWithdraw={handleWithdrawRequest}
            onShowComingSoon={handleShowComingSoon}
            modal={modal}
            onCloseModal={closeModal}
          >
            <InstantLiquidityPage profile={profile} onBack={goBack} />
          </AppLayout>
        );

      case 'more':
        return (
          <AppLayout
            activeTab="more"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <MorePage onNavigate={noOp} />
          </AppLayout>
        );
      case 'markets':
        return (
          <AppLayout
            activeTab="markets"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <MarketsPage
              onBack={noOp}
              onOpenNotifications={noOp}
              onOpenStockDetail={noOp}
              onOpenNewsArticle={noOp}
              onOpenFactsheet={noOp}
            />
          </AppLayout>
        );
      case 'deposit':
        return (
          <AppLayout
            activeTab="deposit"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <DepositPage onBack={noOp} />
          </AppLayout>
        );
      case 'stockDetail':
        return (
          <StockDetailPage
            security={previewSecurity}
            onBack={noOp}
            onOpenBuy={noOp}
          />
        );
      case 'stockBuy':
        return (
          <StockBuyPage
            security={previewSecurity}
            onBack={noOp}
            onContinue={noOp}
          />
        );
      case 'factsheet':
        return (
          <FactsheetPage
            onBack={noOp}
            strategy={previewStrategy}
            onOpenInvest={noOp}
          />
        );
      case 'investAmount':
        return (
          <InvestAmountPage
            onBack={noOp}
            strategy={previewStrategy}
            onContinue={noOp}
          />
        );
      case 'notifications':
        return (
          <NotificationsPage
            onBack={noOp}
            onOpenSettings={noOp}
          />
        );
      case 'notificationSettings':
        return <NotificationSettingsPage onBack={noOp} />;
      case 'settings':
        return (
          <AppLayout
            activeTab="more"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <SettingsPage onNavigate={noOp} onBack={noOp} />
          </AppLayout>
        );
      case 'mintBalance':
        return (
          <AppLayout
            activeTab="home"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <MintBalancePage
              onBack={noOp}
              onOpenInvestments={noOp}
              onOpenCredit={noOp}
              onOpenActivity={noOp}
              onOpenSettings={noOp}
              onOpenInvest={noOp}
              onOpenCreditApply={noOp}
            />
          </AppLayout>
        );
      case 'activity':
        return (
          <AppLayout
            activeTab="home"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <ActivityPage onBack={noOp} />
          </AppLayout>
        );
      case 'actions':
        return (
          <ActionsPage
            onBack={noOp}
            onNavigate={noOp}
          />
        );
      case 'editProfile':
        return <EditProfilePage onNavigate={noOp} onBack={noOp} />;
      case 'profileDetails':
        return <ProfileDetailsPage onNavigate={noOp} onBack={noOp} />;
      case 'creditApply':
        return <CreditApplyPage onBack={noOp} onTabChange={handleTabChange} />;
      case 'creditRepay':
        return <CreditRepayPage onBack={noOp} />;
      case 'identityCheck':
        return <IdentityCheckPage onBack={noOp} onComplete={noOp} />;
      case 'bankLink':
        return <MintBankPage onBack={noOp} onComplete={noOp} />;
      case 'invite':
        return <InvitePage onBack={noOp} />;
      case 'newsArticle':
        return <NewsArticlePage articleId={previewArticleId} onBack={noOp} />;
      case 'openStrategies':
        return <OpenStrategiesPage onBack={noOp} onOpenFactsheet={noOp} />;
      case 'changePassword':
        return <ChangePasswordPage onNavigate={noOp} onBack={noOp} />;
      case 'legal':
        return <LegalDocumentationPage onNavigate={noOp} onBack={noOp} />;
      case 'invest':
        return (
          <AppLayout
            activeTab="home"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <InvestPage
              onBack={noOp}
              onOpenOpenStrategies={noOp}
              onOpenMarkets={noOp}
            />
          </AppLayout>
        );
      case 'biometricsDebug':
        return (
          <AppLayout
            activeTab="more"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <BiometricsDebugPage onNavigate={noOp} onBack={noOp} />
          </AppLayout>
        );
      case 'transact':
        return (
          <AppLayout
            activeTab="transact"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <TransactPage />
          </AppLayout>
        );
      case 'creditScore':
        return (
          <AppLayout
            activeTab="credit"
            onTabChange={noOp}
            onWithdraw={noOp}
            onShowComingSoon={noOp}
            modal={null}
            onCloseModal={noOp}
          >
            <CreditPage
              initialView="score"
              onOpenNotifications={noOp}
              onOpenCreditApply={noOp}
            />
          </AppLayout>
        );
      case 'stockPayment': {
        const previewStockCheckout = isPreview ? (cachedState.stockCheckout || stockCheckout) : stockCheckout;
        const currency = previewStockCheckout.security?.currency || "R";
        const normalizedCurrency = currency.toUpperCase() === "ZAC" ? "R" : currency;
        const paymentItem = previewStockCheckout.security
          ? { ...previewStockCheckout.security, name: previewStockCheckout.security?.name || previewStockCheckout.security?.symbol || "Stock", currency: normalizedCurrency }
          : null;
        return (
          <PaymentPage
            onBack={noOp}
            strategy={paymentItem}
            amount={previewStockCheckout.amount}
            baseAmount={previewStockCheckout.baseAmount}
            shareCount={previewStockCheckout.shareCount}
            onSuccess={noOp}
            onCancel={noOp}
            onOpenDeposit={noOp}
          />
        );
      }
      case 'payment': {
        const previewAmount = isPreview ? (cachedState.investmentAmount || investmentAmount) : investmentAmount;
        return (
          <PaymentPage
            onBack={noOp}
            strategy={previewStrategy}
            amount={previewAmount}
            baseAmount={isPreview ? cachedState.baseInvestmentAmount : baseInvestmentAmount}
            onSuccess={noOp}
            onCancel={noOp}
            onOpenDeposit={() => navigateTo("deposit")}
            initialMethod={pendingPaymentMethod}
          />
        );
      }
      case 'paymentSuccess':
        return <PaymentSuccessPage onDone={noOp} />;
      case 'userOnboarding':
        return <UserOnboardingPage onComplete={noOp} />;
      case 'familyDashboard':
        return (
          <FamilyDashboardPage
            onBack={noOp}
            userId={profile?.id}
            onOpenChildDashboard={(child) => {
              setSelectedFamilyChild(child);
              navigateTo('childDashboard');
            }}
            onGetInsured={(members) => {
              setFuneralCoverInitialDependents(members);
              navigateTo('funeralCover');
            }}
          />
        );
      case 'childDashboard':
        return (
          <ChildDashboardPage
            child={selectedFamilyChild}
            onBack={noOp}
            onOpenFactsheet={(strategy) => {
              setSelectedChildForInvest(selectedFamilyChild);
              setSelectedStrategy(strategy);
              navigateTo("factsheet");
            }}
          />
        );
      default:
        return null;
    }
  }, [selectedSecurity, selectedStrategy, selectedArticleId, stockCheckout, investmentAmount, selectedFamilyChild]);

  const previousPageComponent = useMemo(() => {
    if (!previousPageName || mainTabs.includes(currentPage)) return null;

    // Skip background rendering for SDK-heavy pages to prevent duplicate listeners
    const sdkPages = ["identityCheck", "userOnboarding", "bankLink", "creditApply"];
    if (sdkPages.includes(previousPageName)) return null;

    return renderPageContent(previousPageName, true);
  }, [previousPageName, currentPage, renderPageContent]);

  const handleLockLogout = useCallback(() => {
    if (supabase) supabase.auth.signOut({ scope: 'local' });
    sessionStorage.removeItem('mint_pin_unlocked');
    setShowPinLock(false);
    setCurrentPage("welcome");
  }, []);



  if (currentPage === "linkExpired") {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-semibold text-slate-900 mb-3">Link Expired</h1>
          <p className="text-slate-600 mb-6">
            This password reset link has expired or is no longer valid. Please request a new one.
          </p>
          <button
            onClick={() => openAuthFlow("forgotPassword")}
            className="inline-flex items-center justify-center rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white shadow-lg shadow-slate-900/20 transition hover:-translate-y-0.5"
          >
            Request New Link
          </button>
        </div>
      </div>
    );
  }

  if (showSessionExpired && isAuthenticated) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-50">
        <div className="flex w-full max-w-sm flex-col items-center px-8">
          <div className="flex items-center gap-3 mb-10">
            <img src="/assets/mint-logo.svg" alt="Mint" className="h-6 w-auto" />
            <span className="mint-brand text-lg font-semibold tracking-[0.12em]">MINT</span>
          </div>
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white border-2 border-slate-200 shadow-sm">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-slate-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="mt-6 text-2xl font-bold text-slate-900">Session Expired</h1>
          <p className="mt-2 text-center text-sm text-slate-500">
            Your session has expired. Please log in again to continue.
          </p>
          <button
            type="button"
            onClick={() => {
              setShowSessionExpired(false);
              setShowPinLock(false);
              setCurrentPage("auth");
              setAuthStep("loginEmail");
            }}
            className="mt-8 w-full rounded-full bg-slate-900 py-3.5 text-sm font-semibold text-white shadow-lg shadow-slate-900/20 transition active:scale-95"
          >
            Log In Again
          </button>
        </div>
      </div>
    );
  }

  if (showPinLock && isAuthenticated) {
    return (
      <PinLockScreen
        onUnlock={() => {
          setShowPinLock(false);
          sessionStorage.setItem('mint_pin_unlocked', 'true');
        }}
        onLogout={handleLockLogout}
      />
    );
  }


  if (['home', 'credit', 'investments', 'markets', 'news', 'more'].includes(currentPage)) {
    return (
      <Suspense fallback={<HomeSkeleton />}>
        <>
          {showOpenStrategiesMaintenance && <MaintenanceModal onClose={() => setShowOpenStrategiesMaintenance(false)} />}
          <GiftReceivedPopup onClaim={() => navigateTo("giftCodeEntry")} />
          {/* Home tab – mount on first visit */}
          <div style={{ display: currentPage === 'home' ? 'block' : 'none' }}>
            {mountedTabs.has('home') && (
              <AppLayout
                activeTab={currentPage}
                onTabChange={handleTabChange}
                onWithdraw={handleWithdrawRequest}
                onShowComingSoon={handleShowComingSoon}
                modal={modal}
                onCloseModal={closeModal}
              >
                <HomePage
                  onOpenNotifications={() => { setNotificationReturnPage("home"); navigateTo("notifications"); }}
                  onOpenMintBalance={() => navigateTo("mintBalance")}
                  onOpenActivity={() => navigateTo("activity")}
                  onOpenActions={() => navigateTo("actions")}
                  onOpenInvestments={() => handleTabChange("investments")}
                  onOpenCredit={() => handleTabChange("credit")}
                  onOpenCreditApply={() => navigateTo("creditApply")}
                  onOpenCreditRepay={() => navigateTo("creditRepay")}
                  onOpenInvest={() => { setMarketsInitialView("openstrategies"); navigateTo("markets"); }}
                  onOpenWithdraw={handleWithdrawRequest}
                  onOpenSettings={() => navigateTo("settings")}
                  onOpenStrategies={() => { setMarketsInitialView("openstrategies"); navigateTo("markets"); }}
                  onOpenMarkets={() => { setMarketsInitialView("invest"); navigateTo("markets"); }}
                  onOpenDeposit={() => handleTabChange("deposit")}
                  onOpenNews={() => { handleTabChange("news"); }}
                  onOpenNewsArticle={(articleId) => { setSelectedArticleId(articleId); navigateTo("newsArticle"); }}
                  onOpenInstantLiquidity={() => navigateTo("instantLiquidity")}
                  onOpenFamily={() => navigateTo("familyDashboard")}
                  onSelectMember={(child) => { setSelectedFamilyChild(child); navigateTo("childDashboard"); }}
                  onOpenInsure={() => navigateTo("funeralCover")}
                  onNavigate={navigateTo}
                />
              </AppLayout>
            )}
          </div>
          {/* Investments tab – mount on first visit */}
          <div style={{ display: currentPage === 'investments' ? 'block' : 'none' }}>
            {mountedTabs.has('investments') && (
              <AppLayout
                activeTab={currentPage}
                onTabChange={handleTabChange}
                onWithdraw={handleWithdrawRequest}
                onShowComingSoon={handleShowComingSoon}
                modal={modal}
                onCloseModal={closeModal}
              >
                <NewPortfolioPage
                  onBack={goBack}
                  onOpenNotifications={() => { setNotificationReturnPage("investments"); navigateTo("notifications"); }}
                  onOpenInvest={() => navigateTo("markets")}
                  onOpenStrategies={() => { setMarketsInitialView("openstrategies"); navigateTo("markets"); }}
                  deepLink={portfolioDeepLink}
                  onDeepLinkConsumed={() => setPortfolioDeepLink(null)}
                />
              </AppLayout>
            )}
          </div>
          {/* Markets tab – mount on first visit */}
          <div style={{ display: currentPage === 'markets' ? 'block' : 'none' }}>
            {mountedTabs.has('markets') && (
              <AppLayout
                activeTab={currentPage}
                onTabChange={handleTabChange}
                onWithdraw={() => {}}
                onShowComingSoon={() => {}}
                modal={null}
                onCloseModal={() => {}}
              >
                <MarketsPage
                  onBack={undefined}
                  initialViewMode={marketsInitialView}
                  onViewModeChange={(mode) => setMarketsInitialView(mode)}
                  onOpenNotifications={() => { setNotificationReturnPage("markets"); navigateTo("notifications"); }}
                  onOpenStockDetail={(security) => { setSelectedChildForInvest(null); setMarketsChildFilter(null); setSelectedSecurity(security); navigateTo("stockDetail"); }}
                  onOpenNewsArticle={(articleId) => { setSelectedArticleId(articleId); navigateTo("newsArticle"); }}
                  onOpenFactsheet={(strategy) => { if (!marketsChildFilter) setSelectedChildForInvest(null); setSelectedStrategy(strategy); navigateTo("factsheet"); }}
                  childFilter={marketsChildFilter}
                />
              </AppLayout>
            )}
          </div>
          {/* News tab – mount on first visit */}
          <div style={{ display: currentPage === 'news' ? 'block' : 'none' }}>
            {mountedTabs.has('news') && (
              <AppLayout
                activeTab="news"
                onTabChange={handleTabChange}
                onWithdraw={() => {}}
                onShowComingSoon={() => {}}
                modal={null}
                onCloseModal={() => {}}
              >
                <MarketsPage
                  onBack={undefined}
                  initialViewMode="news"
                  onViewModeChange={() => {}}
                  onOpenNotifications={() => { setNotificationReturnPage("news"); navigateTo("notifications"); }}
                  onOpenStockDetail={(security) => { setSelectedChildForInvest(null); setSelectedSecurity(security); navigateTo("stockDetail"); }}
                  onOpenNewsArticle={(articleId) => { setSelectedArticleId(articleId); navigateTo("newsArticle"); }}
                  onOpenFactsheet={(strategy) => { setSelectedChildForInvest(null); setSelectedStrategy(strategy); navigateTo("factsheet"); }}
                />
              </AppLayout>
            )}
          </div>
          {/* Credit tab – mount on first visit */}
          <div style={{ display: currentPage === 'credit' ? 'block' : 'none' }}>
            {mountedTabs.has('credit') && (
              <AppLayout
                activeTab={currentPage}
                onTabChange={handleTabChange}
                onWithdraw={handleWithdrawRequest}
                onShowComingSoon={handleShowComingSoon}
                modal={modal}
                onCloseModal={closeModal}
              >
                <CreditHome
                  profile={profile}
                  onOpenNotifications={() => {
                    setNotificationReturnPage("credit");
                    navigateTo("notifications");
                  }}
                  onTabChange={handleTabChange}
                />
              </AppLayout>
            )}
          </div>
          {/* More tab – mount on first visit */}
          <div style={{ display: currentPage === 'more' ? 'block' : 'none' }}>
            {mountedTabs.has('more') && (
              <AppLayout
                activeTab={currentPage}
                onTabChange={handleTabChange}
                onWithdraw={handleWithdrawRequest}
                onShowComingSoon={handleShowComingSoon}
                modal={modal}
                onCloseModal={closeModal}
              >
                <MorePage onNavigate={navigateTo} onBeforeLogout={handleBeforeLogout} />
              </AppLayout>
            )}
          </div>
        </>
      </Suspense>
    );
  }

  if (currentPage === "creditScore") {
    return (
      <AppLayout
        activeTab="credit"
        onTabChange={handleTabChange}
        onWithdraw={handleWithdrawRequest}
        onShowComingSoon={handleShowComingSoon}
        modal={modal}
        onCloseModal={closeModal}
      >
        <CreditPage
          initialView="score"
          onOpenNotifications={() => {
            setNotificationReturnPage("credit");
            navigateTo("notifications");
          }}
          onOpenCreditApply={() => navigateTo("creditApply")}
        />
      </AppLayout>
    );
  }

  if (currentPage === "instantLiquidity") {
    return (
      <AppLayout
        activeTab="instantLiquidity"
        onTabChange={handleTabChange}
        onWithdraw={handleWithdrawRequest}
        onShowComingSoon={handleShowComingSoon}
        modal={modal}
        onCloseModal={closeModal}
      >
        <InstantLiquidityPage
          profile={profile}
          onBack={goBack}
          onTabChange={handleTabChange}
          onLinkBank={() => navigateTo("bankLink")}
          onOpenNotifications={() => {
            setNotificationReturnPage("instantLiquidity");
            navigateTo("notifications");
          }}
        />
      </AppLayout>
    );
  }

  if (currentPage === "creditHowItWorks") {
    return (
      <AppLayout
        activeTab="credit"
        onTabChange={handleTabChange}
        onWithdraw={handleWithdrawRequest}
        onShowComingSoon={handleShowComingSoon}
        modal={modal}
        onCloseModal={closeModal}
      >
        <CreditHowItWorksPage
          profile={profile}
          onBack={goBack}
          onTabChange={handleTabChange}
        />
      </AppLayout>
    );
  }

  if (currentPage === "statements") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="statements"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <StatementsPage
            onOpenNotifications={() => {
              setNotificationReturnPage("statements");
              navigateTo("notifications");
            }}
          />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "transact") {
    return (
      <AppLayout
        activeTab="transact"
        onTabChange={handleTabChange}
        onWithdraw={handleWithdrawRequest}
        onShowComingSoon={handleShowComingSoon}
        modal={modal}
        onCloseModal={closeModal}
      >
        <TransactPage />
      </AppLayout>
    );
  }

  if (currentPage === "invest") {
    return (
      <>
      {showOpenStrategiesMaintenance && <MaintenanceModal onClose={() => setShowOpenStrategiesMaintenance(false)} />}
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="home"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <InvestPage
            onBack={goBack}
            onOpenOpenStrategies={() => setShowOpenStrategiesMaintenance(true)}
            onOpenMarkets={() => navigateTo("markets")}
          />
        </AppLayout>
      </SwipeBackWrapper>
      </>
    );
  }

  if (currentPage === "deposit") {
    return (
      <AppLayout
        activeTab="deposit"
        onTabChange={handleTabChange}
        onWithdraw={() => { }}
        onShowComingSoon={() => { }}
        modal={null}
        onCloseModal={() => { }}
      >
        <DepositPage onBack={canSwipeBack ? goBack : () => handleTabChange("home")} />
      </AppLayout>
    );
  }

  if (currentPage === "stockDetail") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <StockDetailPage
          security={selectedSecurity}
          onBack={goBack}
          onOpenBuy={() => navigateTo("stockBuy")}
          onNavigateToOnboarding={() => navigateTo("identityCheck")}
          onProceedToPayment={({ security, amount, baseAmount, shareCount, goalId }) => {
            setStockCheckout({ security, amount, baseAmount: baseAmount || amount, shareCount });
            setSelectedGoalId(goalId || null);
            selectedGoalIdRef.current = goalId || null;
            goalInvestAmountRef.current = baseAmount || amount;
            pendingPaymentTypeRef.current = "stock";
            setShowPaymentMethodModal(true);
          }}
        />
        <PaymentMethodModal
          isOpen={showPaymentMethodModal}
          onClose={() => setShowPaymentMethodModal(false)}
          amount={stockCheckout.amount}
          strategyName={stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock"}
          onSelectPaystack={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("paystack"); navigateTo("stockPayment"); }}
          onSelectWallet={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("wallet"); navigateTo("stockPayment"); }}
          onSelectOzow={async () => {
            try {
              const { data: { user } } = await supabase.auth.getUser();
              const baseUrl = window.location.origin;
              const resp = await fetch("/api/ozow/initiate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  amount: stockCheckout.amount,
                  strategyName: stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock",
                  strategyId: stockCheckout.security?.id || null,
                  userId: user?.id || null,
                  userEmail: user?.email || null,
                  successUrl: `${baseUrl}/?ozow=success`,
                  cancelUrl: `${baseUrl}/?ozow=cancel`,
                  errorUrl: `${baseUrl}/?ozow=error`,
                }),
              });
              const data = await resp.json();
              if (data.success && data.action_url) {
                const form = document.createElement("form");
                form.method = "POST";
                form.action = data.action_url;
                Object.entries(data).forEach(([key, value]) => {
                  if (["success", "action_url"].includes(key)) return;
                  const input = document.createElement("input");
                  input.type = "hidden"; input.name = key; input.value = value;
                  form.appendChild(input);
                });
                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
              } else {
                alert(data.error || "Failed to initiate Ozow payment.");
              }
            } catch (err) { alert("Could not connect to Ozow. Please try another payment method."); }
          }}
          onEFTConfirm={async () => {
            setShowPaymentMethodModal(false);
            try {
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token;
              const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
              await fetch("/api/eft-deposit", {
                method: "POST", headers,
                body: JSON.stringify({
                  amount: stockCheckout.amount,
                  baseAmount: stockCheckout.baseAmount || stockCheckout.amount,
                  reference: `EFT-${Date.now()}`,
                  securityId: stockCheckout.security?.id,
                  symbol: stockCheckout.security?.symbol || "",
                  name: stockCheckout.security?.name || "",
                  ...(stockCheckout.shareCount ? { shareCount: Number(stockCheckout.shareCount) } : {}),
                }),
              });
            } catch (e) { console.error("EFT record error:", e); }
            navigationHistory.current = [];
            setPreviousPageName(null);
            setCurrentPage("home");
          }}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "stockBuy") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <StockBuyPage
          security={selectedSecurity}
          paymentMethod={pendingPaymentMethod}
          onBack={goBack}
          onGiftDone={() => navigateTo("home")}
          onContinue={(amount, security, baseAmount, shareCount) => {
            setStockCheckout({ security, amount, baseAmount: baseAmount || amount, shareCount });
            setPendingGoalFlow({
              type: "stock",
              amount,
              baseAmount: baseAmount || amount,
              assetName: security?.name || security?.symbol || "Stock",
              securityId: security?.id || null,
            });
            setShowGoalModal(true);
          }}
        />
        <GoalLinkModal
          isOpen={showGoalModal && pendingGoalFlow?.type === "stock"}
          onClose={() => { setShowGoalModal(false); setPendingGoalFlow(null); setSelectedGoalId(null); selectedGoalIdRef.current = null; goalInvestAmountRef.current = 0; }}
          onConfirm={async (goalId) => {
            setSelectedGoalId(goalId);
            selectedGoalIdRef.current = goalId;
            goalInvestAmountRef.current = pendingGoalFlow?.baseAmount || pendingGoalFlow?.amount || stockCheckout.amount;
            pendingPaymentTypeRef.current = "stock";
            setShowGoalModal(false);
            setPendingGoalFlow(null);

            // Use ref for latest status to avoid race conditions and destructuring bugs
            if (!onboardingRef.current.loading && !onboardingRef.current.complete) {
              navigateTo("identityCheck");
              return;
            }
            setShowPaymentMethodModal(true);
          }}
          investmentAmount={pendingGoalFlow?.baseAmount || pendingGoalFlow?.amount || stockCheckout.amount}
          assetName={pendingGoalFlow?.assetName || selectedSecurity?.name || "Stock"}
        />
        <PaymentMethodModal
          isOpen={showPaymentMethodModal}
          onClose={() => setShowPaymentMethodModal(false)}
          amount={stockCheckout.amount}
          strategyName={stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock"}
          onSelectPaystack={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("paystack"); navigateTo("stockPayment"); }}
          onSelectWallet={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("wallet"); navigateTo("stockPayment"); }}
          onSelectOzow={async () => {
            try {
              const { data: { user } } = await supabase.auth.getUser();
              const baseUrl = window.location.origin;
              const resp = await fetch("/api/ozow/initiate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  amount: stockCheckout.amount,
                  strategyName: stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock",
                  strategyId: stockCheckout.security?.id || null,
                  userId: user?.id || null,
                  userEmail: user?.email || null,
                  successUrl: `${baseUrl}/?ozow=success`,
                  cancelUrl: `${baseUrl}/?ozow=cancel`,
                  errorUrl: `${baseUrl}/?ozow=error`,
                }),
              });
              const data = await resp.json();
              if (data.success && data.action_url) {
                sessionStorage.setItem("ozow_pending", JSON.stringify({
                  transactionRef: data.TransactionReference,
                  strategyId: data.Optional1,
                  amount: data.Amount,
                }));
                const form = document.createElement("form");
                form.method = "POST";
                form.action = data.action_url;
                const skipFields = ["success", "action_url"];
                Object.entries(data).forEach(([key, value]) => {
                  if (skipFields.includes(key)) return;
                  const input = document.createElement("input");
                  input.type = "hidden";
                  input.name = key;
                  input.value = value;
                  form.appendChild(input);
                });
                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
              } else {
                alert(data.error || "Failed to initiate Ozow payment. Please try again.");
              }
            } catch (err) {
              console.error("Ozow error:", err);
              alert("Could not connect to Ozow. Please try another payment method.");
            }
          }}
          onEFTConfirm={async () => {
            setShowPaymentMethodModal(false);
            try {
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token;
              const eftRef = `EFT-${Date.now()}`;
              const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
              await fetch("/api/eft-deposit", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  amount: stockCheckout.amount,
                  baseAmount: stockCheckout.baseAmount || stockCheckout.amount,
                  reference: eftRef,
                  securityId: stockCheckout.security?.id,
                  symbol: stockCheckout.security?.symbol || "",
                  name: stockCheckout.security?.name || "",
                  ...(stockCheckout.shareCount ? { shareCount: Number(stockCheckout.shareCount) } : {}),
                }),
              });
            } catch (e) {
              console.error("EFT record error:", e);
            }
            navigationHistory.current = [];
            setPreviousPageName(null);
            setCurrentPage("home");
          }}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "stockPayment") {
    const currency = stockCheckout.security?.currency || "R";
    const normalizedCurrency = currency.toUpperCase() === "ZAC" ? "R" : currency;
    const paymentItem = stockCheckout.security
      ? { ...stockCheckout.security, name: stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock", currency: normalizedCurrency }
      : null;
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <PaymentPage
          onBack={goBack}
          strategy={paymentItem}
          amount={stockCheckout.amount}
          baseAmount={stockCheckout.baseAmount}
          shareCount={stockCheckout.shareCount}
          fees={stockCheckout.fees}
          initialMethod={pendingPaymentMethod}
          onOpenDeposit={() => navigateTo("deposit")}
          onSuccess={async (response) => {
            console.log("Payment successful:", response);
            const goalId = selectedGoalIdRef.current;
            const goalAmount = goalInvestAmountRef.current;
            const linkedAssetName = stockCheckout.security?.name || stockCheckout.security?.symbol || "Stock";
            if (goalId && supabase) {
              try {
                const { data: { session } } = await supabase.auth.getSession();
                if (session?.user) {
                  const { data: goal, error: fetchErr } = await supabase
                    .from("investment_goals")
                    .select("current_amount, target_amount")
                    .eq("id", goalId)
                    .single();
                  if (fetchErr) console.error("Error fetching goal for update:", fetchErr);
                  if (goal) {
                    const prevInvested = goal.current_amount || 0;
                    const newInvested = prevInvested + (goalAmount || 0);
                    const progress = goal.target_amount > 0 ? Math.min(100, (newInvested / goal.target_amount) * 100) : 0;
                    const { error: updateErr } = await supabase
                      .from("investment_goals")
                      .update({
                        current_amount: newInvested,
                        linked_asset_name: linkedAssetName,
                      })
                      .eq("id", goalId);
                    if (updateErr) {
                      console.error("Goal update failed:", updateErr);
                    } else {
                      console.log("Goal updated successfully:", { goalId, newInvested, progress });
                    }
                  }
                }
              } catch (e) {
                console.error("Error updating goal:", e);
              }
            }
            selectedGoalIdRef.current = null;
            goalInvestAmountRef.current = 0;
            setSelectedGoalId(null);
            navigationHistory.current = [];
            setPreviousPageName(null);
            setCurrentPage("paymentSuccess");
          }}
          onCancel={goBack}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "newsArticle") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <NewsArticlePage
          articleId={selectedArticleId}
          onBack={goBack}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "openStrategies") {
    goBack();
    if (!showOpenStrategiesMaintenance) setShowOpenStrategiesMaintenance(true);
    return null;
  }

  if (currentPage === "factsheet") {
    return (
      <>
        <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
          <FactsheetPage
            onBack={goBack}
            strategy={selectedStrategy}
            onOpenInvest={(strategy) => {
              setSelectedStrategy(strategy);
              if (marketsChildFilter) {
                setShowChildInvestModal(true);
              } else {
                navigateTo("investAmount");
              }
            }}
            onNavigateToOnboarding={() => navigateTo("identityCheck")}
          />
        </SwipeBackWrapper>
        {showChildInvestModal && marketsChildFilter && selectedStrategy && (
          <ChildInvestModal
            child={marketsChildFilter}
            strategy={selectedStrategy}
            initialStep="amount"
            onClose={() => setShowChildInvestModal(false)}
          />
        )}
      </>
    );
  }

  if (currentPage === "investAmount") {
    const isChildStrategyPurchase = !!selectedStrategy?.is_kid_strategy && !!selectedChildForInvest?.id;

    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <InvestAmountPage
          onBack={goBack}
          strategy={selectedStrategy}
          paymentMethod={pendingPaymentMethod}
          onGiftDone={() => navigateTo("home")}
          onContinue={(amount, baseAmount, shareCount, fees) => {
            setInvestmentAmount(amount);
            setBaseInvestmentAmount(baseAmount || amount);
            setInvestmentFees(fees);
            setPendingGoalFlow({
              type: "strategy",
              amount,
              baseAmount: baseAmount || amount,
              assetName: selectedStrategy?.name || "Strategy",
              strategyId: selectedStrategy?.id || selectedStrategy?.strategyId || null,
              fees // pass fees breakdown
            });
            // Kid strategies bought from Markets ask for the child first.
            // A factsheet opened from a child dashboard already has that child in context.
            if (selectedStrategy?.is_kid_strategy) {
              if (selectedChildForInvest?.id) {
                setShowGoalModal(true);
              } else {
                setShowChildPickerModal(true);
              }
            } else {
              setSelectedChildForInvest(null);
              setShowGoalModal(true);
            }
          }}
        />
        <KidStrategyChildPickerModal
          isOpen={showChildPickerModal}
          onClose={() => { setShowChildPickerModal(false); setPendingGoalFlow(null); }}
          onSelectSelf={() => {
            setSelectedChildForInvest(null);
            setShowChildPickerModal(false);
            setShowGoalModal(true);
          }}
          onSelectChild={(child) => {
            setSelectedChildForInvest(child);
            setShowChildPickerModal(false);
            setShowGoalModal(true);
          }}
        />
        <GoalLinkModal
          isOpen={showGoalModal && pendingGoalFlow?.type === "strategy"}
          onClose={() => { setShowGoalModal(false); setPendingGoalFlow(null); setSelectedGoalId(null); selectedGoalIdRef.current = null; goalInvestAmountRef.current = 0; }}
          onConfirm={async (goalId) => {
            setSelectedGoalId(goalId);
            selectedGoalIdRef.current = goalId;
            goalInvestAmountRef.current = pendingGoalFlow?.baseAmount || pendingGoalFlow?.amount || investmentAmount;
            pendingPaymentTypeRef.current = "strategy";
            setShowGoalModal(false);
            setPendingGoalFlow(null);

            // Use ref for latest status to avoid race conditions and destructuring bugs
            if (!onboardingRef.current.loading && !onboardingRef.current.complete) {
              navigateTo("identityCheck");
              return;
            }

            // Child strategy purchases always pay from the child's wallet — skip the payment method modal
            if (selectedStrategy?.is_kid_strategy && selectedChildForInvest?.id) {
              setPendingPaymentMethod("wallet");
              navigateTo("payment");
              return;
            }

            setShowPaymentMethodModal(true);
          }}
          investmentAmount={pendingGoalFlow?.baseAmount || pendingGoalFlow?.amount || investmentAmount}
          assetName={pendingGoalFlow?.assetName || selectedStrategy?.name || "Strategy"}
          childFamilyMemberId={selectedStrategy?.is_kid_strategy ? selectedChildForInvest?.id : null}
        />
        <PaymentMethodModal
          isOpen={showPaymentMethodModal}
          onClose={() => setShowPaymentMethodModal(false)}
          amount={investmentAmount}
          strategyName={selectedStrategy?.name || "Investment"}
          childFamilyMemberId={isChildStrategyPurchase ? selectedChildForInvest?.id : null}
          childFirstName={isChildStrategyPurchase ? selectedChildForInvest?.first_name : null}
          childWalletBalanceCents={isChildStrategyPurchase ? (selectedChildForInvest?.available_balance ?? null) : null}
          onSelectPaystack={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("paystack"); navigateTo("payment"); }}
          onSelectWallet={() => { setShowPaymentMethodModal(false); setPendingPaymentMethod("wallet"); navigateTo("payment"); }}
          onSelectOzow={async () => {
            try {
              const { data: { user } } = await supabase.auth.getUser();
              const baseUrl = window.location.origin;
              const resp = await fetch("/api/ozow/initiate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  amount: investmentAmount,
                  strategyName: selectedStrategy?.name || "Investment",
                  strategyId: selectedStrategy?.id || null,
                  userId: user?.id || null,
                  userEmail: user?.email || null,
                  successUrl: `${baseUrl}/?ozow=success`,
                  cancelUrl: `${baseUrl}/?ozow=cancel`,
                  errorUrl: `${baseUrl}/?ozow=error`,
                }),
              });
              const data = await resp.json();
              if (data.success && data.action_url) {
                sessionStorage.setItem("ozow_pending", JSON.stringify({
                  transactionRef: data.TransactionReference,
                  strategyId: data.Optional1,
                  amount: data.Amount,
                }));
                const form = document.createElement("form");
                form.method = "POST";
                form.action = data.action_url;
                const skipFields = ["success", "action_url"];
                Object.entries(data).forEach(([key, value]) => {
                  if (skipFields.includes(key)) return;
                  const input = document.createElement("input");
                  input.type = "hidden";
                  input.name = key;
                  input.value = value;
                  form.appendChild(input);
                });
                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
              } else {
                alert(data.error || "Failed to initiate Ozow payment. Please try again.");
              }
            } catch (err) {
              console.error("Ozow error:", err);
              alert("Could not connect to Ozow. Please try another payment method.");
            }
          }}
          onEFTConfirm={async () => {
            setShowPaymentMethodModal(false);
            try {
              const { data: { session } } = await supabase.auth.getSession();
              const token = session?.access_token;
              const eftRef = `EFT-${Date.now()}`;
              const stratId = selectedStrategy?.strategyId || selectedStrategy?.id || null;
              const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
              await fetch("/api/eft-deposit", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  amount: investmentAmount,
                  baseAmount: baseInvestmentAmount || investmentAmount,
                  reference: eftRef,
                  securityId: selectedStrategy?.id,
                  symbol: selectedStrategy?.symbol || selectedStrategy?.short_name || "",
                  name: selectedStrategy?.name || "",
                  strategyId: stratId,
                }),
              });
            } catch (e) {
              console.error("EFT record error:", e);
            }
            navigationHistory.current = [];
            setPreviousPageName(null);
            setCurrentPage("home");
          }}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "payment") {
    const isChildStrategyPurchase = !!selectedStrategy?.is_kid_strategy && !!selectedChildForInvest?.id;

    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <PaymentPage
          onBack={goBack}
          strategy={selectedStrategy}
          amount={investmentAmount}
          baseAmount={baseInvestmentAmount}
          fees={investmentFees || pendingGoalFlow?.fees}
          initialMethod={pendingPaymentMethod}
          childId={isChildStrategyPurchase ? selectedChildForInvest?.linked_user_id || null : null}
          childFamilyMemberId={isChildStrategyPurchase ? selectedChildForInvest?.id || null : null}
          onOpenDeposit={() => navigateTo("deposit")}
          onSuccess={async (response) => {
            console.log("Payment successful:", response);
            const goalId = selectedGoalIdRef.current;
            const goalAmount = goalInvestAmountRef.current;
            const linkedAssetName = selectedStrategy?.name || "Strategy";
            if (goalId && supabase) {
              try {
                const { data: { session } } = await supabase.auth.getSession();
                if (session?.user) {
                  const { data: goal, error: fetchErr } = await supabase
                    .from("investment_goals")
                    .select("current_amount, target_amount")
                    .eq("id", goalId)
                    .single();
                  if (fetchErr) console.error("Error fetching goal for update:", fetchErr);
                  if (goal) {
                    const prevInvested = goal.current_amount || 0;
                    const newInvested = prevInvested + (goalAmount || 0);
                    const progress = goal.target_amount > 0 ? Math.min(100, (newInvested / goal.target_amount) * 100) : 0;
                    const { error: updateErr } = await supabase
                      .from("investment_goals")
                      .update({
                        current_amount: newInvested,
                        linked_asset_name: linkedAssetName,
                      })
                      .eq("id", goalId);
                    if (updateErr) {
                      console.error("Goal update failed:", updateErr);
                    } else {
                      console.log("Goal updated successfully:", { goalId, newInvested, progress });
                    }
                  }
                }
              } catch (e) {
                console.error("Error updating goal:", e);
              }
            }
            selectedGoalIdRef.current = null;
            goalInvestAmountRef.current = 0;
            setSelectedGoalId(null);
            setSelectedChildForInvest(null);
            navigationHistory.current = [];
            setPreviousPageName(null);
            setCurrentPage("paymentSuccess");
          }}
          onCancel={goBack}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "paymentSuccess") {
    return <PaymentSuccessPage onDone={() => setCurrentPage("home")} />;
  }

  if (currentPage === "paymentPending") {
    return (
      <PaymentPendingPage
        strategy={pendingPaymentInfo?.strategy}
        amount={pendingPaymentInfo?.amount}
        onDone={() => { setPendingPaymentInfo(null); setCurrentPage("home"); }}
      />
    );
  }

  if (currentPage === "manageSubscriptions") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ManageSubscriptionsPage onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "settings") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="more"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <SettingsPage onNavigate={navigateTo} onBack={goBack} />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "biometricsDebug") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="more"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <BiometricsDebugPage onNavigate={navigateTo} onBack={goBack} />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "editProfile") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <EditProfilePage onNavigate={navigateTo} onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "familyDashboard") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <FamilyDashboardPage
          onBack={goBack}
          userId={profile?.id}
          onOpenChildDashboard={(child) => {
            setSelectedFamilyChild(child);
            navigateTo("childDashboard");
          }}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "childDashboard") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ChildDashboardPage
          child={selectedFamilyChild}
          onBack={goBack}
          onOpenFactsheet={(strategy) => {
            setSelectedChildForInvest(selectedFamilyChild);
            setSelectedStrategy(strategy);
            navigateTo("factsheet");
          }}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "funeralCover") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <FuneralCoverPage onBack={goBack} userId={profile?.id} profile={profile} initialDependents={funeralCoverInitialDependents} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "profileDetails") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ProfileDetailsPage onNavigate={navigateTo} onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "notifications") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <NotificationsPage
          onBack={goBack}
          onOpenSettings={() => navigateTo("notificationSettings")}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "notificationSettings") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <NotificationSettingsPage onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "mintBalance") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="home"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <MintBalancePage
            onBack={goBack}
            onOpenInvestments={() => setCurrentPage("investments")}
            onOpenCredit={() => setCurrentPage("credit")}
            onOpenActivity={() => navigateTo("activity")}
            onOpenSettings={() => navigateTo("settings")}
            onOpenInvest={() => navigateTo("markets")}
            onOpenCreditApply={() => navigateTo("creditApply")}
          />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "activity") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="home"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <ActivityPage onBack={goBack} />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "actions") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ActionsPage
          onBack={goBack}
          onNavigate={navigateTo}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "identityCheck") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <IdentityCheckPage
          onBack={() => navigateTo("home")}
          onComplete={() => navigateTo("home")}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "bankLink") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <MintBankPage
          onBack={goBack}
          onComplete={() => setCurrentPage("home")}
        />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "invite") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <InvitePage onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "creditApply") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="creditApply"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={modal}
          onCloseModal={closeModal}
        >
          <CreditApplyPage
            onBack={goBack}
            onTabChange={navigateTo}
            onOpenNotifications={() => {
              setNotificationReturnPage("creditApply");
              navigateTo("notifications");
            }}
          />
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "unsecuredCreditDashboard") {
    return (
      <AppLayout
        activeTab="creditApply"
        onTabChange={handleTabChange}
        onWithdraw={handleWithdrawRequest}
        onShowComingSoon={handleShowComingSoon}
        modal={modal}
        onCloseModal={closeModal}
      >
        <UnsecuredCreditDashboard
          profile={profile}
          onTabChange={navigateTo}
          onOpenNotifications={() => {
            setNotificationReturnPage("unsecuredCreditDashboard");
            navigateTo("notifications");
          }}
        />
      </AppLayout>
    );
  }

  if (currentPage === "creditRepay") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <CreditRepayPage onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "changePassword") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ChangePasswordPage onNavigate={navigateTo} onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "activeSessions") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <ActiveSessionsPage onBack={goBack} onLogout={() => { if (supabase) supabase.auth.signOut(); setCurrentPage("welcome"); }} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "pinSetup") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <PinSetupPage onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "legal") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <LegalDocumentationPage onNavigate={navigateTo} onBack={goBack} />
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "userOnboarding") {
    return <UserOnboardingPage onComplete={() => setCurrentPage("home")} />;
  }

  if (currentPage === "giftClaim" || currentPage === "giftCodeEntry") {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#f8f6fa]" />}>
        <GiftCodeEntryPage
          onBack={() => navigateTo("home")}
          onNavigate={(page, params) => {
            if (page === "giftPreview") {
              setGiftPreviewData(params);
              navigateTo("giftPreview");
            } else {
              navigateTo(page);
            }
          }}
        />
      </Suspense>
    );
  }

  if (currentPage === "giftPreview") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <Suspense fallback={<div className="min-h-screen bg-[#f8f6fa]" />}>
          <GiftPreviewPage
            code={giftPreviewData?.code}
            idNumber={giftPreviewData?.idNumber}
            giftPreview={giftPreviewData?.giftPreview}
            onBack={goBack}
            onNavigate={navigateTo}
          />
        </Suspense>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "sentGifts") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <Suspense fallback={<div className="min-h-screen bg-[#f8f6fa]" />}>
          <SentGiftsPageV2 onBack={goBack} />
        </Suspense>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "giftStrategies") {
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <AppLayout
          activeTab="home"
          onTabChange={handleTabChange}
          onWithdraw={handleWithdrawRequest}
          onShowComingSoon={handleShowComingSoon}
          modal={null}
          onCloseModal={() => {}}
        >
          <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
            <GiftStrategyPickerPage
              onBack={goBack}
              onNavigate={(page, params) => {
                if (page === "giftStrategyInvest") {
                  setPageParams(params);
                  navigateTo("giftStrategyInvest");
                } else {
                  navigateTo(page);
                }
              }}
            />
          </Suspense>
        </AppLayout>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "giftStrategyInvest") {
    const strategy = pageParams?.strategy;
    return (
      <SwipeBackWrapper onBack={goBack} enabled={canSwipeBack} previousPage={previousPageComponent}>
        <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
          <InvestAmountPage
            strategy={strategy}
            onBack={goBack}
            onContinue={() => navigateTo("home")}
            onGiftDone={() => navigateTo("home")}
            startWithGiftOpen
          />
        </Suspense>
      </SwipeBackWrapper>
    );
  }

  if (currentPage === "welcome") {
    return (
      <OnboardingPage
        onCreateAccount={() => openAuthFlow("email")}
        onLogin={() => openAuthFlow("loginEmail")}
      />
    );
  }

  const recordSession = async () => {
    try {
      if (!supabase) return;
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;
      const ua = navigator.userAgent || '';
      let browser = 'Unknown';
      if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'Chrome';
      else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
      else if (ua.includes('Firefox')) browser = 'Firefox';
      else if (ua.includes('Edg')) browser = 'Edge';
      else if (ua.includes('Opera') || ua.includes('OPR')) browser = 'Opera';
      let os = 'Unknown';
      if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
      else if (ua.includes('Android')) os = 'Android';
      else if (ua.includes('Mac OS')) os = 'macOS';
      else if (ua.includes('Windows')) os = 'Windows';
      else if (ua.includes('Linux')) os = 'Linux';
      const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
      const deviceType = isMobile ? 'mobile' : 'desktop';
      let fingerprint = localStorage.getItem('mint_session_fingerprint');
      if (!fingerprint) {
        fingerprint = 'sf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('mint_session_fingerprint', fingerprint);
      }
      const res = await fetch('/api/sessions/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userAgent: ua, browser, os, deviceType, sessionFingerprint: fingerprint }),
      });
      const json = await res.json();
      if (json.sessionId) {
        localStorage.setItem('mint_session_id', json.sessionId);
      }
    } catch (err) {
      console.error('Failed to record session:', err);
    }
  };

  const handleSignupComplete = async () => {
    justLoggedInRef.current = true;
    sessionCheckSkipUntilRef.current = Date.now() + 30000;
    localStorage.setItem('mint_last_activity', Date.now().toString());
    setCurrentPage("home");
    try {
      await recordSession();
      if (supabase) {
        const { data: userData } = await supabase.auth.getUser();
        if (userData?.user) {
          await createWelcomeNotification(userData.user.id).catch(() => { });
          await refetchNotifications().catch(() => { });
        }
      }
    } catch (err) {
      console.error('Post-signup tasks error:', err);
    }
    justLoggedInRef.current = false;
  };

  const handleLoginComplete = async () => {
    justLoggedInRef.current = true;
    sessionCheckSkipUntilRef.current = Date.now() + 30000;
    setShowSessionExpired(false);
    localStorage.setItem('mint_last_activity', Date.now().toString());
    const returnPage = sessionExpiredPageRef.current;
    if (returnPage && !['welcome', 'auth', 'linkExpired'].includes(returnPage)) {
      setCurrentPage(returnPage);
      sessionExpiredPageRef.current = null;
    } else {
      setCurrentPage("home");
    }
    try {
      await recordSession();
      if (supabase) {
        const { data: userData } = await supabase.auth.getUser();
        if (userData?.user) {
          await refetchNotifications().catch(() => { });
        }
      }
    } catch (err) {
      console.error('Post-login tasks error:', err);
    }
    justLoggedInRef.current = false;
  };

  const handlePreLogin = () => {
    justLoggedInRef.current = true;
    sessionCheckSkipUntilRef.current = Date.now() + 30000;
  };

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f8f9fc]" />}>
      <AuthPage
        initialStep={authStep}
        onSignupComplete={handleSignupComplete}
        onLoginComplete={handleLoginComplete}
        onPreLogin={handlePreLogin}
      />
    </Suspense>
  );
};

export default App;

