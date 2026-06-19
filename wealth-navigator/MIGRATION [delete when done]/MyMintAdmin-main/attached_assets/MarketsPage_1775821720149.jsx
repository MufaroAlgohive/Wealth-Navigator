import React, { useEffect, useState, useRef, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../lib/supabase.js";
import { getMarketsSecuritiesWithMetrics } from "../lib/marketData.js";
import { getStrategiesWithMetrics, getPublicStrategies, formatChangePct, formatChangeAbs, getChangeColor } from "../lib/strategyData.js";
import { useProfile } from "../lib/useProfile";
import { TrendingUp, Search, SlidersHorizontal, X, ChevronRight, Star } from "lucide-react";
import { saveMarketsInvestFilters, loadMarketsInvestFilters, saveMarketsStrategyFilters, loadMarketsStrategyFilters, buildInvestChips, buildChipsFromFilters } from "../lib/usePersistedFilters.js";
import NotificationBell from "../components/NotificationBell";
import FamilyDropdown from "../components/FamilyDropdown";
import Skeleton from "../components/Skeleton";
import { ChartContainer } from "../components/ui/line-charts-2";
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "../lib/formatCurrency";
import { normalizeSymbol, getHoldingsArray, getHoldingSymbol, buildHoldingsBySymbol, getStrategyHoldingsSnapshot, calculateMinInvestment, getAdjustedShares } from "../lib/strategyUtils";

const sortOptions = ["Market Cap", "Dividend Yield", "P/E Ratio"];

const MIN_ASSET_VALUE_DISPLAY = 1000;

const strategySortOptions = [
  "Recommended",
  "Best performance",
  "Lowest max drawdown",
  "Lowest volatility",
  "Lowest minimum",
  "Most popular",
];

const riskOptions = ["Low risk", "Balanced", "Growth", "High risk"];
const minInvestmentOptions = ["R500+", "R2,500+", "R10,000+"];
const exposureOptions = ["Local", "Global", "Mixed", "Equities", "ETFs"];
const timeHorizonOptions = ["Short", "Medium", "Long"];
const strategySectorOptions = ["Technology", "Consumer", "Healthcare", "Energy", "Financials"];
const strategyTimeframeOptions = [
  { key: "1W", label: "1W" },
  { key: "1M", label: "1M" },
  { key: "3M", label: "3M" },
  { key: "6M", label: "6M" },
  { key: "YTD", label: "YTD" },
];
const previewFallbackLength = 140;

// Mini chart component for strategy cards
const StrategyMiniChart = ({ values }) => {
  const chartConfig = {
    returnPct: {
      label: "Return",
      color: "var(--color-mint-purple, #5b21b6)",
    },
  };
  const data = useMemo(
    () =>
      values.map((value, index) => ({
        label: `P${index + 1}`,
        returnPct: value,
      })),
    [values],
  );
  const lastIndex = data.length - 1;
  const gradientId = useId();
  const [activeLabel, setActiveLabel] = useState(null);
  const renderLastDot = ({ cx, cy, index }) => {
    if (index !== lastIndex) return null;
    return (
      <g>
        <circle cx={cx} cy={cy} r={5} fill="#ffffff" opacity={0.95} />
        <circle cx={cx} cy={cy} r={2.5} fill={chartConfig.returnPct.color} />
      </g>
    );
  };

  return (
    <ChartContainer config={chartConfig} className="h-12 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 4, right: 6, left: 6, bottom: 4 }}
          onMouseMove={(state) => {
            if (state?.activeLabel) {
              setActiveLabel(state.activeLabel);
            }
          }}
          onMouseLeave={() => {
            setActiveLabel(null);
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5b21b6" stopOpacity={0.22} />
              <stop offset="70%" stopColor="#3b1b7a" stopOpacity={0.08} />
              <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
            </linearGradient>
          </defs>

          {activeLabel ? (
            <ReferenceLine
              x={activeLabel}
              stroke="#CBD5E1"
              strokeOpacity={0.7}
              strokeDasharray="3 3"
            />
          ) : null}

          <Area
            type="monotone"
            dataKey="returnPct"
            stroke="transparent"
            fill={`url(#${gradientId})`}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="returnPct"
            stroke={chartConfig.returnPct.color}
            strokeWidth={2}
            dot={renderLastDot}
            activeDot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
};

const MarketsPage = ({ onBack, onOpenNotifications, onOpenStockDetail, onOpenNewsArticle, onOpenFactsheet, initialViewMode, onViewModeChange }) => {
  const { profile, loading: profileLoading } = useProfile();
  const [portalTarget, setPortalTarget] = useState(null);
  const [securities, setSecurities] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [publicStrategies, setPublicStrategies] = useState([]);
  const [holdingsSecurities, setHoldingsSecurities] = useState([]);
  const [newsArticles, setNewsArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [publicStrategiesLoading, setPublicStrategiesLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [strategiesSearchQuery, setStrategiesSearchQuery] = useState("");
  const [newsSearchQuery, setNewsSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState(initialViewMode || "invest"); // "openstrategies", "invest", "news"

  useEffect(() => {
    if (initialViewMode && initialViewMode !== viewMode) {
      setViewMode(initialViewMode);
    }
  }, [initialViewMode]);

  useEffect(() => {
    onViewModeChange?.(viewMode);
  }, [viewMode]);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [selectedStrategyTimeframe, setSelectedStrategyTimeframe] = useState("YTD");
  const [selectedStrategyActiveLabel, setSelectedStrategyActiveLabel] = useState(null);
  const [selectedStrategyAnalytics, setSelectedStrategyAnalytics] = useState(null);
  const [selectedStrategyAnalyticsLoading, setSelectedStrategyAnalyticsLoading] = useState(false);
  const [strategyYtdById, setStrategyYtdById] = useState({});
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [sheetOffset, setSheetOffset] = useState(0);
  const dragStartY = useRef(null);
  const isDragging = useRef(false);
  
  // Filter states for Invest view (restored from localStorage)
  const _savedInvest = useMemo(() => loadMarketsInvestFilters(), []);
  const [selectedSort, setSelectedSort] = useState(_savedInvest?.sort || "Market Cap");
  const [selectedSectors, setSelectedSectors] = useState(_savedInvest?.sectors || new Set());
  const [selectedExchanges, setSelectedExchanges] = useState(_savedInvest?.exchanges || new Set());
  const [draftSort, setDraftSort] = useState(_savedInvest?.sort || "Market Cap");
  const [draftSectors, setDraftSectors] = useState(_savedInvest?.sectors || new Set());
  const [draftExchanges, setDraftExchanges] = useState(_savedInvest?.exchanges || new Set());
  
  const _savedStrat = useMemo(() => loadMarketsStrategyFilters(), []);
  const [strategySort, setStrategySort] = useState(_savedStrat?.sort || "Recommended");
  const [selectedRisks, setSelectedRisks] = useState(_savedStrat?.risks || new Set());
  const [selectedMinInvestment, setSelectedMinInvestment] = useState(_savedStrat?.minInvestment ?? null);
  const [selectedExposure, setSelectedExposure] = useState(_savedStrat?.exposure || new Set());
  const [selectedTimeHorizon, setSelectedTimeHorizon] = useState(_savedStrat?.timeHorizon || new Set());
  const [selectedStrategySectors, setSelectedStrategySectors] = useState(_savedStrat?.sectors || new Set());
  const [draftStrategySort, setDraftStrategySort] = useState(_savedStrat?.sort || "Recommended");
  const [draftRisks, setDraftRisks] = useState(_savedStrat?.risks || new Set());
  const [draftMinInvestment, setDraftMinInvestment] = useState(_savedStrat?.minInvestment ?? null);
  const [draftExposure, setDraftExposure] = useState(_savedStrat?.exposure || new Set());
  const [draftTimeHorizon, setDraftTimeHorizon] = useState(_savedStrat?.timeHorizon || new Set());
  const [draftStrategySectors, setDraftStrategySectors] = useState(_savedStrat?.sectors || new Set());

  const [activeChips, setActiveChips] = useState(() => {
    if (viewMode === "openstrategies" && _savedStrat) return buildChipsFromFilters(_savedStrat);
    if (viewMode === "invest" && _savedInvest) return buildInvestChips(_savedInvest);
    return [];
  });

  const [watchlist, setWatchlist] = useState([]);

  useEffect(() => { setPortalTarget(document.body); }, []);

  useEffect(() => {
    if (profile?.watchlist && Array.isArray(profile.watchlist)) {
      setWatchlist(profile.watchlist);
    }
  }, [profile]);

  const toggleWatchlist = async (e, symbol) => {
    e.stopPropagation();
    if (!profile?.id) return;

    const isWatched = watchlist.includes(symbol);
    const newWatchlist = isWatched
      ? watchlist.filter((t) => t !== symbol)
      : [...watchlist, symbol];

    setWatchlist(newWatchlist);

    const { error } = await supabase
      .from('profiles')
      .update({ watchlist: newWatchlist })
      .eq('id', profile.id);

    if (error) {
      setWatchlist(watchlist);
      console.error("Watchlist sync failed:", error);
    }
  };

  const watchedSecurities = useMemo(() => {
    return securities.filter((s) => watchlist.includes(s.symbol));
  }, [securities, watchlist]);

  const holdingsBySymbol = useMemo(() => buildHoldingsBySymbol(holdingsSecurities), [holdingsSecurities]);
  const previewGradientId = useId();
  
  // News pagination
  const [newsPage, setNewsPage] = useState(1);
  const newsPerPage = 7;

  const displayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  useEffect(() => {
    const fetchSecurities = async () => {
      setLoading(true);
      
      try {
        const data = await getMarketsSecuritiesWithMetrics();
        console.log("📊 Fetched securities:", data);
        console.log("📊 Securities with prices:", data.filter(s => s.currentPrice != null).length);
        console.log("📊 Securities without prices:", data.filter(s => s.currentPrice == null).length);
        setSecurities(data);
      } catch (error) {
        console.error("Error fetching securities:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSecurities();
  }, []);

  // Fetch strategies with metrics
  useEffect(() => {
    const fetchStrategies = async () => {
      setStrategiesLoading(true);
      
      try {
        const data = await getStrategiesWithMetrics();
        console.log("✅ Fetched strategies:", data);
        setStrategies(data);
      } catch (error) {
        console.error("Error fetching strategies:", error);
        setStrategies([]);
      } finally {
        setStrategiesLoading(false);
      }
    };

    fetchStrategies();
  }, []);

  // Fetch public strategies for OpenStrategies view
  useEffect(() => {
    const fetchPublicStrategies = async () => {
      setPublicStrategiesLoading(true);
      
      try {
        const data = await getPublicStrategies();
        console.log("✅ Fetched public strategies:", data);
        setPublicStrategies(data);
      } catch (error) {
        console.error("Error fetching public strategies:", error);
        setPublicStrategies([]);
      } finally {
        setPublicStrategiesLoading(false);
      }
    };

    fetchPublicStrategies();
  }, []);

  // Fetch YTD returns for OpenStrategies cards using the same source as Factsheet
  useEffect(() => {
    const fetchStrategyYtd = async () => {
      if (!supabase || publicStrategies.length === 0) {
        setStrategyYtdById({});
        return;
      }

      try {
        const strategyIds = [...new Set(publicStrategies.map((strategy) => strategy.id).filter(Boolean))];
        if (strategyIds.length === 0) {
          setStrategyYtdById({});
          return;
        }

        const { data, error } = await supabase
          .from("strategy_analytics")
          .select("strategy_id, ytd_return, summary")
          .in("strategy_id", strategyIds);

        if (error) throw error;

        const nextMap = (data || []).reduce((acc, row) => {
          const summaryYtd = row?.summary?.ytd_return;
          acc[row.strategy_id] = summaryYtd ?? row?.ytd_return ?? null;
          return acc;
        }, {});

        setStrategyYtdById(nextMap);
      } catch (error) {
        console.error("Error fetching strategy YTD analytics:", error);
        setStrategyYtdById({});
      }
    };

    fetchStrategyYtd();
  }, [publicStrategies]);

  // Fetch holdings securities for strategy cards (only if we have mock data)
  useEffect(() => {
    const fetchHoldingsSecurities = async () => {
      const strategySources = [...strategies, ...publicStrategies];
      if (!supabase || strategySources.length === 0) return;

      try {
        // Get all unique ticker symbols from strategies if they have holdings
        const allTickers = [...new Set(
          strategySources
            .flatMap((strategy) => getHoldingsArray(strategy).flatMap((h) => {
              const rawSymbol = h.ticker || h.symbol || h;
              const normalizedSymbol = normalizeSymbol(rawSymbol);
              return normalizedSymbol && normalizedSymbol !== rawSymbol
                ? [rawSymbol, normalizedSymbol]
                : [rawSymbol];
            }))
        )];
        
        if (allTickers.length === 0) return;

        const chunkSize = 50;
        const chunks = [];
        for (let i = 0; i < allTickers.length; i += chunkSize) {
          chunks.push(allTickers.slice(i, i + chunkSize));
        }

        const results = await Promise.all(
          chunks.map((symbols) => (
            supabase
              .from("securities_c")
              .select("id, symbol, logo_url, name, last_price")
              .in("symbol", symbols)
          )),
        );

        const merged = [];
        results.forEach(({ data, error }) => {
          if (error) {
            console.error("Error fetching holdings securities chunk:", error);
            return;
          }
          if (data?.length) merged.push(...data);
        });

        if (merged.length) {
          setHoldingsSecurities(merged);
        }
      } catch (error) {
        console.error("Error fetching holdings securities:", error);
      }
    };

    fetchHoldingsSecurities();
  }, [strategies, publicStrategies]);

  // Fetch news articles
  useEffect(() => {
    const fetchNewsArticles = async () => {
      if (!supabase) {
        console.log("❌ Supabase not initialized");
        return;
      }

      try {
        console.log("🔍 Fetching news articles from News_articles table...");
        const { data, error, count } = await supabase
          .from("News_articles")
          .select("id, title, source, published_at", { count: 'exact' })
          .order("published_at", { ascending: false })
          .limit(50);

        if (error) {
          console.error("❌ Error fetching news articles:", error);
          console.error("Error code:", error.code);
          console.error("Error message:", error.message);
          console.error("Error hint:", error.hint);
          console.error("Error details:", error.details);
          console.error("Full error:", JSON.stringify(error, null, 2));
        } else {
          console.log("✅ News articles fetched successfully!");
          console.log("📊 Total count in DB:", count);
          console.log("📰 Articles returned:", data?.length || 0);
          console.log("Sample article:", data?.[0]);
          setNewsArticles(data || []);
        }
      } catch (error) {
        console.error("💥 Exception while fetching news articles:", error);
      }
    };

    fetchNewsArticles();
  }, []);

  // Reset news page when search query changes
  useEffect(() => {
    setNewsPage(1);
  }, [newsSearchQuery]);

  const sectors = useMemo(() => {
    return [...new Set(securities.map((s) => s.sector).filter(Boolean))];
  }, [securities]);

  const exchanges = useMemo(() => {
    return [...new Set(securities.map((s) => s.exchange).filter(Boolean))];
  }, [securities]);

  const filteredSecurities = useMemo(() => {
    let filtered = securities.filter((security) => {
      const matchesSearch =
        security.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        security.symbol?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        security.sector?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesSector = selectedSectors.size === 0 || selectedSectors.has(security.sector);
      const matchesExchange = selectedExchanges.size === 0 || selectedExchanges.has(security.exchange);

      return matchesSearch && matchesSector && matchesExchange;
    });

    // Sort
    if (selectedSort === "Market Cap") {
      filtered.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
    } else if (selectedSort === "Dividend Yield") {
      filtered.sort((a, b) => (b.dividend_yield || 0) - (a.dividend_yield || 0));
    } else if (selectedSort === "P/E Ratio") {
      filtered.sort((a, b) => (a.pe || Infinity) - (b.pe || Infinity));
    } else if (selectedSort === "Beta") {
      filtered.sort((a, b) => (b.beta || 0) - (a.beta || 0));
    }

    return filtered;
  }, [securities, searchQuery, selectedSectors, selectedExchanges, selectedSort]);

  const largestCompanies = useMemo(() => {
    return filteredSecurities
      .filter((s) => s.market_cap)
      .sort((a, b) => b.market_cap - a.market_cap)
      .slice(0, 10);
  }, [filteredSecurities]);

  const highestDividendYield = useMemo(() => {
    return filteredSecurities
      .filter((s) => s.dividend_yield && s.dividend_yield > 0)
      .sort((a, b) => b.dividend_yield - a.dividend_yield)
      .slice(0, 10);
  }, [filteredSecurities]);

  const publicStrategiesWithMetrics = useMemo(() => {
    if (!publicStrategies.length) return [];

    const strategiesById = new Map(strategies.map((strategy) => [strategy.id, strategy]));

    return publicStrategies.map((publicStrategy) => {
      const strategyWithMetrics = strategiesById.get(publicStrategy.id);
      const analyticsYtd = strategyYtdById[publicStrategy.id];
      if (!strategyWithMetrics) {
        return {
          ...publicStrategy,
          r_ytd: analyticsYtd ?? null,
        };
      }

      return {
        ...publicStrategy,
        r_ytd: analyticsYtd ?? strategyWithMetrics.r_ytd ?? strategyWithMetrics.latest_metric?.r_ytd ?? null,
      };
    });
  }, [publicStrategies, strategies, strategyYtdById]);

  const filteredStrategies = useMemo(() => {
    // Use publicStrategies for OpenStrategies view
    const results = publicStrategiesWithMetrics.filter((strategy) => {
      const matchesName =
        strategiesSearchQuery.length === 0
          ? true
          : (strategy.name?.toLowerCase().includes(strategiesSearchQuery.toLowerCase()) ||
             strategy.short_name?.toLowerCase().includes(strategiesSearchQuery.toLowerCase()) ||
             strategy.description?.toLowerCase().includes(strategiesSearchQuery.toLowerCase()) ||
             (strategy.tags && strategy.tags.some(tag => tag.toLowerCase().includes(strategiesSearchQuery.toLowerCase()))));
      
      const matchesRisk = selectedRisks.size
        ? selectedRisks.has(strategy.risk_level)
        : true;
      
      const minInvest = calculateMinInvestment(strategy, holdingsBySymbol);
      let investmentCategory = null;
      if (minInvest != null) {
        if (minInvest >= 10000) investmentCategory = "R10,000+";
        else if (minInvest >= 2500) investmentCategory = "R2,500+";
        else investmentCategory = "R500+";
      }
      
      const matchesMinInvestment = selectedMinInvestment && selectedMinInvestment !== "Any"
        ? minInvest != null && investmentCategory === selectedMinInvestment
        : true;
      
      const matchesExposure = selectedExposure.size
        ? selectedExposure.has(strategy.objective)
        : true;
      
      const matchesTimeHorizon = selectedTimeHorizon.size
        ? (strategy.tags && strategy.tags.some(tag => selectedTimeHorizon.has(tag)))
        : true;
      
      const matchesSector = selectedStrategySectors.size
        ? (strategy.sector && selectedStrategySectors.has(strategy.sector))
        : true;

      return (
        matchesName &&
        matchesRisk &&
        matchesMinInvestment &&
        matchesExposure &&
        matchesTimeHorizon &&
        matchesSector
      );
    });

    // Sort strategies - already ordered by is_featured desc, name asc from database
    // But apply client-side sorts if selected
    const sorted = [...results];
    if (strategySort === "Best performance") {
      // Would need performance metrics for this
      sorted.sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0));
    }
    if (strategySort === "Lowest minimum") {
      sorted.sort((a, b) => (calculateMinInvestment(a, holdingsBySymbol) || 0) - (calculateMinInvestment(b, holdingsBySymbol) || 0));
    }

    return sorted;
  }, [
    publicStrategiesWithMetrics,
    strategiesSearchQuery,
    selectedRisks,
    selectedMinInvestment,
    selectedExposure,
    selectedTimeHorizon,
    selectedStrategySectors,
    strategySort,
  ]);

  const gainers = useMemo(() => {
    // Generate mock percentage gains for now (will be replaced with real data)
    return filteredSecurities
      .filter((s) => s.market_cap)
      .map((s) => ({
        ...s,
        // Mock gain calculation based on some metrics
        percentGain: s.dividend_yield ? Number(s.dividend_yield) * 2 + Math.random() * 10 : Math.random() * 15 + 5
      }))
      .sort((a, b) => b.percentGain - a.percentGain)
      .slice(0, 10);
  }, [filteredSecurities]);

  const filteredNews = useMemo(() => {
    return newsArticles.filter(article => 
      newsSearchQuery.length === 0 ||
      article.title?.toLowerCase().includes(newsSearchQuery.toLowerCase()) ||
      article.source?.toLowerCase().includes(newsSearchQuery.toLowerCase())
    );
  }, [newsArticles, newsSearchQuery]);

  const paginatedNews = useMemo(() => {
    const startIndex = (newsPage - 1) * newsPerPage;
    const endIndex = startIndex + newsPerPage;
    return filteredNews.slice(startIndex, endIndex);
  }, [filteredNews, newsPage, newsPerPage]);

  const totalNewsPages = Math.ceil(filteredNews.length / newsPerPage);

  const formatMarketCap = (value) => {
    if (!value) return "—";
    const num = Number(value);
    if (num >= 1e12) return `R${(num / 1e12).toFixed(2)}T`;
    if (num >= 1e9) return `R${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `R${(num / 1e6).toFixed(2)}M`;
    return `R${num.toFixed(2)}`;
  };

  const getDisplayCurrency = () => "R";

  const formatPrice = (security) => {
    if (security.currentPrice != null) {
      return Number(security.currentPrice).toFixed(2);
    }
    return "—";
  };


  useEffect(() => {
    if (!selectedStrategy) {
      setSelectedStrategyAnalytics(null);
      setSelectedStrategyAnalyticsLoading(false);
      return;
    }

    let isMounted = true;
    const fetchAnalytics = async () => {
      if (!supabase) {
        if (isMounted) {
          setSelectedStrategyAnalytics(null);
        }
        return;
      }

      setSelectedStrategyAnalyticsLoading(true);

      try {
        const strategyId = selectedStrategy.id || selectedStrategy.strategy_id;
        if (!strategyId) {
          setSelectedStrategyAnalytics(null);
          return;
        }

        const { data, error } = await supabase
          .from("strategy_analytics")
          .select("strategy_id, as_of_date, base_currency, latest_value, curves, computed_at, error")
          .eq("strategy_id", strategyId)
          .maybeSingle();

        if (error) throw error;
        if (isMounted) {
          setSelectedStrategyAnalytics(data || null);
        }
      } catch (error) {
        if (isMounted) {
          setSelectedStrategyAnalytics(null);
        }
      } finally {
        if (isMounted) {
          setSelectedStrategyAnalyticsLoading(false);
        }
      }
    };

    fetchAnalytics();
    return () => {
      isMounted = false;
    };
  }, [selectedStrategy]);

  useEffect(() => {
    if (!selectedStrategy) return;

    const originalOverflow = document.body.style.overflow;
    const appContent = document.querySelector(".app-content");
    const originalAppContentOverflow = appContent?.style.overflow;

    document.body.style.overflow = "hidden";
    if (appContent) {
      appContent.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = originalOverflow;
      if (appContent) {
        appContent.style.overflow = originalAppContentOverflow || "";
      }
    };
  }, [selectedStrategy]);

  const availablePreviewTimeframes = useMemo(() => {
    const curves = selectedStrategyAnalytics?.curves || {};
    return strategyTimeframeOptions
      .map((option) => option.key)
      .filter((key) => Array.isArray(curves[key]) && curves[key].length > 0);
  }, [selectedStrategyAnalytics]);

  useEffect(() => {
    if (!availablePreviewTimeframes.length) return;
    setSelectedStrategyTimeframe((prev) => {
      if (availablePreviewTimeframes.includes(prev)) return prev;
      if (availablePreviewTimeframes.includes("1M")) return "1M";
      return availablePreviewTimeframes[0];
    });
  }, [availablePreviewTimeframes]);

  const { previewChartData, previewChartDomain, previewBaseIndexValue } = useMemo(() => {
    const curves = selectedStrategyAnalytics?.curves || {};
    const fallbackSeries = Array.from({ length: previewFallbackLength }, (_, index) => {
      const wave = Math.sin(index / 18) * 1.1 + Math.cos(index / 9) * 0.4;
      const drift = (index / previewFallbackLength) * 1.6;
      const noise = ((index % 7) - 3) * 0.03;
      return {
        d: new Date(Date.now() - (previewFallbackLength - index) * 86400000).toISOString(),
        v: Number((100 + wave + drift + noise).toFixed(2)),
      };
    });
    const series = Array.isArray(curves[selectedStrategyTimeframe]) && curves[selectedStrategyTimeframe].length > 0
      ? curves[selectedStrategyTimeframe]
      : fallbackSeries;
    const labelIndices = series.length ? [0, Math.floor(series.length / 2), series.length - 1] : [];
    const values = series.map((point) => point?.v ?? 0);
    const minValue = values.length ? Math.min(...values) : 0;
    const maxValue = values.length ? Math.max(...values) : 0;
    const padding = (maxValue - minValue) * 0.2;
    const domain = values.length
      ? [minValue - padding, maxValue + padding]
      : [0, 0];
    const mapped = series.map((point, index) => {
      const date = point?.d ? new Date(point.d) : null;
      const dateLabel = labelIndices.includes(index) && date
        ? date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "";
      return {
        label: index + 1,
        dateLabel,
        returnPct: point?.v ?? 0,
      };
    });

    return {
      previewChartData: mapped,
      previewChartDomain: domain,
      previewBaseIndexValue: values.length ? values[0] : null,
    };
  }, [selectedStrategyAnalytics, selectedStrategyTimeframe]);

  const previewLastIndex = previewChartData.length - 1;
  const previewLastValue = previewChartData[previewLastIndex]?.returnPct ?? null;
  const previewFirstValue = previewBaseIndexValue;
  const previewPeriodReturn = previewChartData.length > 1 && previewFirstValue
    ? ((previewLastValue - previewFirstValue) / previewFirstValue) * 100
    : null;
  const previewChartLineColor = previewPeriodReturn > 0
    ? "#16a34a"
    : previewPeriodReturn < 0
      ? "#dc2626"
      : "#94a3b8";

  const resetSheetPosition = () => {
    setSheetOffset(0);
    dragStartY.current = null;
    isDragging.current = false;
  };

  const handleSheetPointerDown = (event) => {
    dragStartY.current = event.clientY;
    isDragging.current = true;
  };

  const handleSheetPointerMove = (event) => {
    if (!isDragging.current || dragStartY.current === null) return;
    const delta = event.clientY - dragStartY.current;
    setSheetOffset(delta > 0 ? delta : 0);
  };

  const handleSheetPointerUp = () => {
    if (!isDragging.current) return;
    if (sheetOffset > 80) {
      setIsFilterOpen(false);
    }
    resetSheetPosition();
  };

  const applyFilters = () => {
    const newSectors = new Set(draftSectors);
    const newExchanges = new Set(draftExchanges);
    setSelectedSort(draftSort);
    setSelectedSectors(newSectors);
    setSelectedExchanges(newExchanges);
    
    const chips = [];
    if (draftSectors.size) chips.push(...Array.from(draftSectors));
    if (draftExchanges.size) chips.push(...Array.from(draftExchanges));
    setActiveChips(chips);
    setIsFilterOpen(false);
    saveMarketsInvestFilters({ sort: draftSort, sectors: newSectors, exchanges: newExchanges });
  };

  const clearAllFilters = () => {
    setSelectedSort("Market Cap");
    setSelectedSectors(new Set());
    setSelectedExchanges(new Set());
    setDraftSort("Market Cap");
    setDraftSectors(new Set());
    setDraftExchanges(new Set());
    setActiveChips([]);
    saveMarketsInvestFilters({ sort: "Market Cap", sectors: new Set(), exchanges: new Set() });
  };

  const removeChip = (chip) => {
    let newSectors = selectedSectors;
    let newExchanges = selectedExchanges;
    if (sectors.includes(chip)) {
      newSectors = new Set(selectedSectors);
      newSectors.delete(chip);
      setSelectedSectors(newSectors);
    } else if (exchanges.includes(chip)) {
      newExchanges = new Set(selectedExchanges);
      newExchanges.delete(chip);
      setSelectedExchanges(newExchanges);
    }
    setActiveChips((prev) => prev.filter((item) => item !== chip));
    saveMarketsInvestFilters({ sort: selectedSort, sectors: newSectors, exchanges: newExchanges });
  };

  const applyStrategyFilters = () => {
    const newRisks = new Set(draftRisks);
    const newExposure = new Set(draftExposure);
    const newTimeHorizon = new Set(draftTimeHorizon);
    const newSectors = new Set(draftStrategySectors);
    setStrategySort(draftStrategySort);
    setSelectedRisks(newRisks);
    setSelectedMinInvestment(draftMinInvestment);
    setSelectedExposure(newExposure);
    setSelectedTimeHorizon(newTimeHorizon);
    setSelectedStrategySectors(newSectors);
    
    const chips = [];
    if (draftRisks.size) chips.push(...Array.from(draftRisks));
    if (draftExposure.size) chips.push(...Array.from(draftExposure));
    if (draftMinInvestment) chips.push(draftMinInvestment);
    if (draftTimeHorizon.size) chips.push(...Array.from(draftTimeHorizon));
    if (draftStrategySectors.size) chips.push(...Array.from(draftStrategySectors));
    setActiveChips(chips);
    setIsFilterOpen(false);
    saveMarketsStrategyFilters({ sort: draftStrategySort, risks: newRisks, minInvestment: draftMinInvestment, exposure: newExposure, timeHorizon: newTimeHorizon, sectors: newSectors });
  };

  const clearAllStrategyFilters = () => {
    setStrategySort("Recommended");
    setSelectedRisks(new Set());
    setSelectedMinInvestment(null);
    setSelectedExposure(new Set());
    setSelectedTimeHorizon(new Set());
    setSelectedStrategySectors(new Set());
    setDraftStrategySort("Recommended");
    setDraftRisks(new Set());
    setDraftMinInvestment(null);
    setDraftExposure(new Set());
    setDraftTimeHorizon(new Set());
    setDraftStrategySectors(new Set());
    setActiveChips([]);
    saveMarketsStrategyFilters({ sort: "Recommended", risks: new Set(), minInvestment: null, exposure: new Set(), timeHorizon: new Set(), sectors: new Set() });
  };

  if (profileLoading || loading) {
    return (
      <div className="min-h-screen bg-slate-50 pb-[env(safe-area-inset-bottom)]">
        <div className="rounded-b-[36px] bg-gradient-to-b from-[#111111] via-[#3b1b7a] to-[#5b21b6] px-4 pb-12 pt-12">
          <div className="mx-auto flex w-full max-w-sm flex-col gap-6 md:max-w-md">
            <header className="flex items-center justify-between">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-10 w-10 rounded-full" />
            </header>
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        </div>
        <div className="mx-auto -mt-10 flex w-full max-w-sm flex-col gap-4 px-4 pb-10 md:max-w-md">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-[env(safe-area-inset-bottom)] text-slate-900">
      {/* Header */}
      <div className="rounded-b-[36px] bg-gradient-to-b from-[#111111] via-[#3b1b7a] to-[#5b21b6] px-4 pb-6 pt-12 text-white md:px-8">
        <div className="mx-auto flex w-full max-w-sm flex-col gap-6 md:max-w-md">
          <header className="flex items-center justify-between text-white">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            ) : (
              <FamilyDropdown
                profile={profile}
                userId={profile?.id}
                initials={initials}
                avatarUrl={profile?.avatarUrl}
                onOpenFamily={() =>
                  window.dispatchEvent(new CustomEvent("navigate-within-app", { detail: { page: "family" } }))
                }
                onSelectMember={(member) =>
                  window.dispatchEvent(new CustomEvent("navigate-within-app", { detail: { page: "memberPortfolio", member } }))
                }
              />
            )}
            <h1 className="text-lg font-semibold">Markets</h1>
            <NotificationBell onClick={onOpenNotifications} />
          </header>

          {/* Toggle between OpenStrategies, Invest, and News */}
          <div className="flex gap-2 rounded-2xl bg-white/10 p-1 backdrop-blur-sm">
            <button
              onClick={() => {
                setViewMode("openstrategies");
                setActiveChips(buildChipsFromFilters({ risks: selectedRisks, exposure: selectedExposure, minInvestment: selectedMinInvestment, timeHorizon: selectedTimeHorizon, sectors: selectedStrategySectors }));
              }}
              className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                viewMode === "openstrategies"
                  ? "bg-white text-slate-900 shadow-md"
                  : "text-white/70"
              }`}
            >
              OpenStrategies
            </button>
            <button
              onClick={() => {
                setViewMode("invest");
                setActiveChips(buildInvestChips({ sectors: selectedSectors, exchanges: selectedExchanges }));
              }}
              className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                viewMode === "invest"
                  ? "bg-white text-slate-900 shadow-md"
                  : "text-white/70"
              }`}
            >
              Invest
            </button>
            <button
              onClick={() => {
                setViewMode("news");
                setActiveChips([]);
              }}
              className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${
                viewMode === "news"
                  ? "bg-white text-slate-900 shadow-md"
                  : "text-white/70"
              }`}
            >
              News
            </button>
          </div>

          {viewMode === "invest" && (
            <>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/50" />
                <input
                  type="text"
                  placeholder="Search by name, symbol, or sector..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-2xl border border-white/20 bg-white/10 px-12 py-3 text-sm text-white placeholder-white/50 backdrop-blur-sm focus:border-white/40 focus:bg-white/15 focus:outline-none"
                />
              </div>
            </>
          )}

          {viewMode === "openstrategies" && (
            <>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/50" />
                <input
                  type="text"
                  placeholder="Search strategies..."
                  value={strategiesSearchQuery}
                  onChange={(e) => setStrategiesSearchQuery(e.target.value)}
                  className="w-full rounded-2xl border border-white/20 bg-white/10 px-12 py-3 text-sm text-white placeholder-white/50 backdrop-blur-sm focus:border-white/40 focus:bg-white/15 focus:outline-none"
                />
              </div>
            </>
          )}

          {viewMode === "news" && (
            <>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/50" />
                <input
                  type="text"
                  placeholder="Search news..."
                  value={newsSearchQuery}
                  onChange={(e) => setNewsSearchQuery(e.target.value)}
                  className="w-full rounded-2xl border border-white/20 bg-white/10 px-12 py-3 text-sm text-white placeholder-white/50 backdrop-blur-sm focus:border-white/40 focus:bg-white/15 focus:outline-none"
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto -mt-2 flex w-full max-w-sm flex-col gap-6 px-4 pb-10 md:max-w-md md:px-8">
        {viewMode === "openstrategies" && (
          <>
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => {
                  setIsFilterOpen(true);
                  setDraftStrategySort(strategySort);
                  setDraftRisks(new Set(selectedRisks));
                  setDraftMinInvestment(selectedMinInvestment);
                  setDraftExposure(new Set(selectedExposure));
                  setDraftTimeHorizon(new Set(selectedTimeHorizon));
                  setDraftStrategySectors(new Set(selectedStrategySectors));
                }}
                className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:bg-slate-50 active:scale-95"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
              </button>
              <span className="text-sm font-medium text-slate-500">
                {filteredStrategies.length} {filteredStrategies.length === 1 ? 'strategy' : 'strategies'}
              </span>
            </div>

            {/* Active Filter Chips for OpenStrategies */}
            {(selectedRisks.size > 0 || 
              selectedMinInvestment !== null && selectedMinInvestment !== "Any" || 
              selectedExposure.size > 0 || 
              selectedTimeHorizon.size > 0 || 
              selectedStrategySectors.size > 0) && (
              <div className="flex flex-wrap gap-2">
                {Array.from(selectedRisks).map((risk) => (
                  <button
                    key={risk}
                    onClick={() => {
                      const next = new Set(selectedRisks);
                      next.delete(risk);
                      setSelectedRisks(next);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {risk}
                    <X className="h-3 w-3" />
                  </button>
                ))}
                {selectedMinInvestment !== null && selectedMinInvestment !== "Any" && (
                  <button
                    onClick={() => setSelectedMinInvestment("Any")}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {selectedMinInvestment}
                    <X className="h-3 w-3" />
                  </button>
                )}
                {Array.from(selectedExposure).map((exp) => (
                  <button
                    key={exp}
                    onClick={() => {
                      const next = new Set(selectedExposure);
                      next.delete(exp);
                      setSelectedExposure(next);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {exp}
                    <X className="h-3 w-3" />
                  </button>
                ))}
                {Array.from(selectedTimeHorizon).map((th) => (
                  <button
                    key={th}
                    onClick={() => {
                      const next = new Set(selectedTimeHorizon);
                      next.delete(th);
                      setSelectedTimeHorizon(next);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {th}
                    <X className="h-3 w-3" />
                  </button>
                ))}
                {Array.from(selectedStrategySectors).map((sector) => (
                  <button
                    key={sector}
                    onClick={() => {
                      const next = new Set(selectedStrategySectors);
                      next.delete(sector);
                      setSelectedStrategySectors(next);
                    }}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {sector}
                    <X className="h-3 w-3" />
                  </button>
                ))}
                <button
                  onClick={clearAllStrategyFilters}
                  className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-all active:scale-95"
                >
                  Clear all
                </button>
              </div>
            )}
          </>
        )}

        {viewMode === "invest" ? (
          <>
            {/* Filter and Sort Bar */}
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => {
                  setIsFilterOpen(true);
                  setDraftSort(selectedSort);
                  setDraftSectors(new Set(selectedSectors));
                  setDraftExchanges(new Set(selectedExchanges));
                }}
                className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm transition-all active:scale-95"
              >
                <SlidersHorizontal className="h-4 w-4 text-slate-600" />
                <span className="text-sm font-semibold text-slate-700">Filter & Sort</span>
              </button>
              <span className="text-sm font-medium text-slate-500">
                {filteredSecurities.length} stocks
              </span>
            </div>

            {/* Active Filter Chips */}
            {activeChips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {activeChips.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => removeChip(chip)}
                    className="flex items-center gap-1.5 rounded-full bg-purple-100 px-3 py-1.5 text-xs font-semibold text-purple-700 transition-all active:scale-95"
                  >
                    {chip}
                    <X className="h-3 w-3" />
                  </button>
                ))}
                <button
                  onClick={clearAllFilters}
                  className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 transition-all active:scale-95"
                >
                  Clear all
                </button>
              </div>
            )}

            {/* Grouped Sections - only show when NOT searching */}
            {!searchQuery && (
              <>
                {watchedSecurities.length > 0 && (
                  <section>
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-lg font-bold text-slate-900">My Watchlist</h2>
                      <ChevronRight className="h-5 w-5 text-slate-400" />
                    </div>
                    <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 scrollbar-hide">
                      {watchedSecurities.map((security) => (
                        <button
                          key={security.id}
                          onClick={() => onOpenStockDetail(security)}
                          className="relative flex-shrink-0 w-64 snap-center rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-5 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                        >
                          <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="absolute top-3 right-3 z-10">
                            <Star className="h-5 w-5 fill-yellow-400 text-yellow-400" />
                          </div>
                          <div className="flex items-start gap-3">
                            {security.logo_url ? (
                              <img
                                src={security.logo_url}
                                alt={security.symbol}
                                className="h-12 w-12 rounded-full border border-slate-100 object-cover flex-shrink-0"
                              />
                            ) : (
                              <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-purple-600 text-sm font-bold text-white">
                                {security.symbol?.substring(0, 2) || "—"}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="truncate text-sm font-bold text-slate-900">
                                {security.short_name || security.name}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500">{security.symbol}</p>
                              <div className="mt-2">
                                {security.currentPrice != null ? (
                                  <>
                                    <p className="text-lg font-bold text-slate-900">
                                      <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                                      {formatPrice(security)}
                                    </p>
                                    {security.changePct != null && (
                                      <p className={`mt-1 text-xs font-semibold ${
                                        security.changePct >= 0 ? 'text-emerald-600' : 'text-red-600'
                                      }`}>
                                        {security.changePct >= 0 ? '+' : ''}{security.changePct.toFixed(2)}%
                                      </p>
                                    )}
                                  </>
                                ) : (
                                  <p className="text-xs text-slate-500">No pricing data</p>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                )}

                {/* Largest Companies Section */}
                <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900">Largest companies</h2>
                <ChevronRight className="h-5 w-5 text-slate-400" />
              </div>
              <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 scrollbar-hide">
                {largestCompanies.map((security) => (
                  <button
                    key={security.id}
                    onClick={() => onOpenStockDetail(security)}
                    className="relative flex-shrink-0 w-64 snap-center rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-5 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                  >
                    <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="absolute top-3 right-3 z-10">
                      <Star className={`h-5 w-5 ${watchlist.includes(security.symbol) ? "fill-yellow-400 text-yellow-400" : "text-slate-300"}`} />
                    </div>
                    <div className="flex items-start gap-3">
                      {security.logo_url ? (
                        <img
                          src={security.logo_url}
                          alt={security.symbol}
                          className="h-12 w-12 rounded-full border border-slate-100 object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-purple-600 text-sm font-bold text-white">
                          {security.symbol?.substring(0, 2) || "—"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">
                          {security.short_name || security.name}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">{security.symbol}</p>
                        <div className="mt-2">
                          {security.currentPrice != null ? (
                            <>
                              <p className="text-lg font-bold text-slate-900">
                                <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                                {formatPrice(security)}
                              </p>
                              {security.changePct != null && (
                                <p className={`mt-1 text-xs font-semibold ${
                                  security.changePct >= 0 ? 'text-emerald-600' : 'text-red-600'
                                }`}>
                                  {security.changePct >= 0 ? '+' : ''}{security.changePct.toFixed(2)}%
                                </p>
                              )}
                            </>
                          ) : (
                            <p className="text-xs text-slate-500">No pricing data</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* Highest Dividend Yield Section */}
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900">Highest dividend yield</h2>
                <ChevronRight className="h-5 w-5 text-slate-400" />
              </div>
              <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 scrollbar-hide">
                {highestDividendYield.map((security) => (
                  <button
                    key={security.id}
                    onClick={() => onOpenStockDetail(security)}
                    className="relative flex-shrink-0 w-64 snap-center rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-5 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                  >
                    <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="absolute top-3 right-3 z-10">
                      <Star className={`h-5 w-5 ${watchlist.includes(security.symbol) ? "fill-yellow-400 text-yellow-400" : "text-slate-300"}`} />
                    </div>
                    <div className="flex items-start gap-3">
                      {security.logo_url ? (
                        <img
                          src={security.logo_url}
                          alt={security.symbol}
                          className="h-12 w-12 rounded-full border border-slate-100 object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 text-sm font-bold text-white">
                          {security.symbol?.substring(0, 2) || "—"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">
                          {security.short_name || security.name}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">{security.symbol}</p>
                        <div className="mt-2">
                          {security.currentPrice != null ? (
                            <div className="flex items-baseline gap-2">
                              <p className="text-lg font-bold text-slate-900">
                                <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                                {formatPrice(security)}
                              </p>
                              {security.changePct != null && (
                                <span className={`text-xs font-semibold ${
                                  security.changePct >= 0 ? 'text-emerald-600' : 'text-red-600'
                                }`}>
                                  {security.changePct >= 0 ? '+' : ''}{security.changePct.toFixed(2)}%
                                </span>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-slate-400">—</p>
                          )}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
                            {Number(security.dividend_yield).toFixed(2)}% yield
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* Gainers Section */}
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900">Gainers</h2>
                <ChevronRight className="h-5 w-5 text-slate-400" />
              </div>
              <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-4 scrollbar-hide">
                {gainers.map((security) => (
                  <button
                    key={security.id}
                    onClick={() => onOpenStockDetail(security)}
                    className="relative flex-shrink-0 w-64 snap-center rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-5 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                  >
                    <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="absolute top-3 right-3 z-10">
                      <Star className={`h-5 w-5 ${watchlist.includes(security.symbol) ? "fill-yellow-400 text-yellow-400" : "text-slate-300"}`} />
                    </div>
                    <div className="flex items-start gap-3">
                      {security.logo_url ? (
                        <img
                          src={security.logo_url}
                          alt={security.symbol}
                          className="h-12 w-12 rounded-full border border-slate-100 object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-sm font-bold text-white">
                          {security.symbol?.substring(0, 2) || "—"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">
                          {security.short_name || security.name}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">{security.symbol}</p>
                        <div className="mt-2">
                          {security.currentPrice != null ? (
                            <p className="text-lg font-bold text-slate-900">
                              <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                              {formatPrice(security)}
                            </p>
                          ) : (
                            <p className="text-xs text-slate-500">No pricing data</p>
                          )}
                        </div>
                        <p className="mt-1 text-xs font-semibold text-emerald-600">
                          +{security.percentGain.toFixed(2)}%
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* All Section */}
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900">All</h2>
                <ChevronRight className="h-5 w-5 text-slate-400" />
              </div>
              <div className="space-y-3">
                {filteredSecurities.map((security) => (
                  <button
                    key={security.id}
                    onClick={() => onOpenStockDetail(security)}
                    className="w-full rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-4 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                  >
                    <div className="flex items-start gap-3">
                      {security.logo_url ? (
                        <img
                          src={security.logo_url}
                          alt={security.symbol}
                          className="h-12 w-12 rounded-full border border-slate-100 object-cover"
                        />
                      ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-purple-600 text-sm font-bold text-white">
                          {security.symbol?.substring(0, 2) || "—"}
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-sm font-semibold text-slate-900">
                              {security.short_name || security.name}
                            </p>
                            <p className="text-xs text-slate-500">
                              {security.symbol} · {security.exchange}
                            </p>
                          </div>
                          <div className="text-right">
                            {security.currentPrice != null ? (
                              <>
                                <p className="text-sm font-semibold text-slate-900">
                                  <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                                  {formatPrice(security)}
                                </p>
                                {security.changePct != null && (
                                  <p className={`text-xs font-semibold ${
                                    security.changePct >= 0 ? 'text-emerald-600' : 'text-red-600'
                                  }`}>
                                    {security.changePct >= 0 ? '+' : ''}{security.changePct.toFixed(2)}%
                                  </p>
                                )}
                              </>
                            ) : (
                              <p className="text-xs text-slate-500">No pricing data</p>
                            )}
                          </div>
                          <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="ml-2 flex-shrink-0">
                            <Star className={`h-5 w-5 ${watchlist.includes(security.symbol) ? "fill-yellow-400 text-yellow-400" : "text-slate-300"}`} />
                          </div>
                        </div>

                        <div className="mt-3 flex items-center gap-2">
                          {security.sector && (
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-600">
                              {security.sector}
                            </span>
                          )}
                          {security.pe && (
                            <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700">
                              P/E {Number(security.pe).toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
              </>
            )}

            {/* All Securities List */}
            {searchQuery && (
              <section>
                <h2 className="mb-4 text-lg font-bold text-slate-900">Search results</h2>
                {filteredSecurities.length === 0 ? (
                  <div className="rounded-3xl bg-white px-6 py-12 text-center shadow-md">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
                      <Search className="h-8 w-8 text-slate-400" />
                    </div>
                    <p className="text-sm font-semibold text-slate-700">No securities found</p>
                    <p className="mt-1 text-xs text-slate-400">Try adjusting your search or filter</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredSecurities.map((security) => (
                      <button
                        key={security.id}
                        onClick={() => onOpenStockDetail(security)}
                        className="w-full rounded-3xl border border-slate-100/80 bg-white/90 backdrop-blur-sm p-4 text-left shadow-[0_2px_16px_-2px_rgba(0,0,0,0.08)] transition-all hover:shadow-[0_4px_24px_-4px_rgba(0,0,0,0.12)] active:scale-[0.97]"
                      >
                        <div className="flex items-start gap-3">
                          {security.logo_url ? (
                            <img
                              src={security.logo_url}
                              alt={security.symbol}
                              className="h-12 w-12 rounded-full border border-slate-100 object-cover"
                            />
                          ) : (
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-purple-600 text-sm font-bold text-white">
                              {security.symbol?.substring(0, 2) || "—"}
                            </div>
                          )}

                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="truncate text-sm font-semibold text-slate-900">
                                  {security.short_name || security.name}
                                </p>
                                <p className="text-xs text-slate-500">
                                  {security.symbol} · {security.exchange}
                                </p>
                              </div>
                              <div className="text-right">
                                {security.currentPrice != null ? (
                                  <>
                                    <p className="text-sm font-semibold text-slate-900">
                                      <span className="text-xs text-slate-400 font-normal">{getDisplayCurrency(security)}</span>{' '}
                                      {formatPrice(security)}
                                    </p>
                                    {security.changePct != null && (
                                      <p className={`text-xs font-semibold ${
                                        security.changePct >= 0 ? 'text-emerald-600' : 'text-red-600'
                                      }`}>
                                        {security.changePct >= 0 ? '+' : ''}{security.changePct.toFixed(2)}%
                                      </p>
                                    )}
                                  </>
                                ) : (
                                  <p className="text-xs text-slate-400">—</p>
                                )}
                              </div>
                              <div onClick={(e) => toggleWatchlist(e, security.symbol)} className="ml-2 flex-shrink-0">
                                <Star className={`h-5 w-5 ${watchlist.includes(security.symbol) ? "fill-yellow-400 text-yellow-400" : "text-slate-300"}`} />
                              </div>
                            </div>

                            <div className="mt-3 flex items-center gap-2">
                              {security.sector && (
                                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-600">
                                  {security.sector}
                                </span>
                              )}
                              {security.pe && (
                                <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700">
                                  P/E {Number(security.pe).toFixed(2)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        ) : viewMode === "openstrategies" ? (
          /* OpenStrategies View */
          <>
            {publicStrategiesLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-64 w-full rounded-2xl" />
                <Skeleton className="h-64 w-full rounded-2xl" />
              </div>
            ) : filteredStrategies.length === 0 ? (
              <div className="rounded-3xl bg-white px-6 py-12 text-center shadow-md">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
                  <Search className="h-8 w-8 text-slate-400" />
                </div>
                <p className="text-sm font-semibold text-slate-700">No strategies available</p>
                <p className="mt-1 text-xs text-slate-400">Check back soon for new investment strategies</p>
              </div>
            ) : (
              /* Strategies grouped by sector */
              [...new Set(filteredStrategies.map(s => s.sector || 'General'))].map((sector) => {
                const sectorStrategies = filteredStrategies.filter(s => (s.sector || 'General') === sector);
                
                if (sectorStrategies.length === 0) return null;
              
              return (
                <section key={sector}>
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-slate-900">{sector}</h2>
                    <ChevronRight className="h-5 w-5 text-slate-400" />
                  </div>
                  <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 scrollbar-hide">
                    {sectorStrategies.map((strategy) => {
                      // Use short_name if available, otherwise use name
                      const displayName = strategy.short_name || strategy.name;
                      
                      // Truncate description to 110-140 chars
                      const truncatedDescription = strategy.description 
                        ? strategy.description.length > 140
                          ? strategy.description.substring(0, 137) + '...'
                          : strategy.description
                        : '';
                      
                      const calcMin = calculateMinInvestment(strategy, holdingsBySymbol);
                      const formattedMinInvestment = calcMin ? `Min. ${formatCurrency(calcMin, "R")}` : null;
                      
                      const sparkline = [20, 22, 21, 24, 26, 25, 28, 30, 29, 32];
                      
                      const holdingsSnapshot = getStrategyHoldingsSnapshot(strategy, holdingsBySymbol);
                      
                      return (
                      <button
                        key={strategy.id}
                        type="button"
                        onClick={() => {
                          // Navigate using slug and id
                          console.log('Opening strategy:', { slug: strategy.slug, id: strategy.id, strategy });
                          setSelectedStrategy({ ...strategy, slug: strategy.slug });
                        }}
                        className="flex-shrink-0 w-80 rounded-2xl border border-slate-100 bg-white shadow-sm hover:shadow-md hover:border-slate-200 p-4 transition-all snap-center"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-1 flex items-start justify-between gap-4">
                            <div className="text-left space-y-1">
                              <p className="text-sm font-semibold text-slate-900">{displayName}</p>
                              <div>
                                <p className="text-xs text-slate-600 line-clamp-1">
                                  {strategy.risk_level || 'Balanced'} {strategy.objective && `• ${strategy.objective}`}
                                </p>
                                <p className="text-[11px] text-slate-400 line-clamp-1">
                                  {formattedMinInvestment}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center rounded-xl bg-slate-50 px-2">
                              <StrategyMiniChart values={sparkline} />
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          {(strategy.tags && strategy.tags.length > 0 ? strategy.tags.slice(0, 2) : [strategy.risk_level || 'Balanced']).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600"
                            >
                              {tag}
                            </span>
                          ))}
                          {strategy.is_featured && (
                            <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-600">
                              Featured
                            </span>
                          )}
                        </div>

                        <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                          <span className="text-xs font-semibold text-slate-600">YTD return</span>
                          <span className={`text-xs font-semibold ${getChangeColor(strategy.r_ytd)}`}>
                            {formatChangePct(strategy.r_ytd)}
                          </span>
                        </div>

                        {holdingsSnapshot.length > 0 && (
                          <div className="mt-3 flex items-center gap-3">
                            <div className="flex -space-x-2">
                              {holdingsSnapshot.slice(0, 3).map((holding) => (
                                <div
                                  key={`${displayName}-${holding.id || holding.symbol}-snapshot`}
                                  className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-white bg-white shadow-sm"
                                >
                                  {holding.logo_url ? (
                                    <img
                                      src={holding.logo_url}
                                      alt={holding.name}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center bg-slate-100 text-[8px] font-bold text-slate-600">
                                      {holding.symbol?.substring(0, 2)}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {holdingsSnapshot.length > 3 ? (
                                <div className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500">
                                  +{Math.max(0, holdingsSnapshot.length - 3)}
                                </div>
                              ) : null}
                            </div>
                            <span className="text-xs font-semibold text-slate-500">Holdings snapshot</span>
                          </div>
                        )}

                        {strategy.provider_name && (
                        <div className="mt-3 flex items-center gap-2">
                          <span className="text-xs text-slate-500">Provider:</span>
                          <span className="text-xs font-semibold text-slate-700">{strategy.provider_name}</span>
                        </div>
                        )}
                      </button>
                      );
                    })}
                  </div>
                </section>
              );
            })
            )}
          </>
        ) : (
          /* News View */
          <div className="space-y-3">
            {filteredNews.length === 0 ? (
              <div className="rounded-3xl bg-white px-6 py-16 text-center shadow-md">
                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-slate-100">
                  <TrendingUp className="h-10 w-10 text-slate-400" />
                </div>
                <p className="text-sm font-semibold text-slate-700">No news articles available</p>
                <p className="mt-2 text-xs text-slate-400">
                  Stay tuned for the latest market updates and insights
                </p>
              </div>
            ) : (
              <>
                {paginatedNews.map((article) => {
                  const publishedDate = new Date(article.published_at);
                  const now = new Date();
                  const diffInHours = Math.floor((now - publishedDate) / (1000 * 60 * 60));
                  let timeText;
                  
                  if (diffInHours < 1) {
                    const diffInMinutes = Math.floor((now - publishedDate) / (1000 * 60));
                    timeText = diffInMinutes <= 1 ? "Just now" : `${diffInMinutes}m ago`;
                  } else if (diffInHours < 24) {
                    timeText = `${diffInHours}h ago`;
                  } else {
                    const diffInDays = Math.floor(diffInHours / 24);
                    timeText = diffInDays === 1 ? "Yesterday" : `${diffInDays}d ago`;
                  }

                  return (
                    <button
                      key={article.id}
                      onClick={() => onOpenNewsArticle(article.id)}
                      className="w-full rounded-3xl bg-white p-5 shadow-md transition-all active:scale-[0.98] text-left"
                    >
                      <h3 className="text-sm font-semibold text-slate-900 line-clamp-2">
                        {article.title}
                      </h3>
                      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                        <span className="inline-flex items-center gap-1.5">
                          <img
                            src="/assets/mint-logo.svg"
                            alt="Mint"
                            className="h-3.5 w-3.5"
                          />
                          <span className="font-medium">Mint News</span>
                        </span>
                        <span>•</span>
                        <span>{timeText}</span>
                      </div>
                    </button>
                  );
                })}
                
                {/* Pagination Controls */}
                {totalNewsPages > 1 && (
                  <div className="flex items-center justify-center gap-2 pt-4">
                    <button
                      onClick={() => setNewsPage(p => Math.max(1, p - 1))}
                      disabled={newsPage === 1}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-slate-600">
                      Page {newsPage} of {totalNewsPages}
                    </span>
                    <button
                      onClick={() => setNewsPage(p => Math.min(totalNewsPages, p + 1))}
                      disabled={newsPage === totalNewsPages}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Strategy Preview Modal */}
      {selectedStrategy && portalTarget && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4 overscroll-contain"
          style={{ paddingBottom: "calc(var(--navbar-height, 64px) + 8px)" }}
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            aria-label="Close preview"
            onClick={() => setSelectedStrategy(null)}
          />
          <div className="relative z-10 flex w-full max-w-sm flex-col overflow-hidden rounded-[32px] bg-white shadow-2xl" style={{ maxHeight: "calc(90vh - var(--navbar-height, 64px) - 16px)" }}>
            <button
              type="button"
              onClick={() => setSelectedStrategy(null)}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 z-10"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            
            <div
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-6"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex items-start gap-3 mb-6">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-slate-900">{selectedStrategy.name}</h2>
                  <p className="text-sm text-slate-500">
                    {calculateMinInvestment(selectedStrategy, holdingsBySymbol) ? `Min. ${formatCurrency(calculateMinInvestment(selectedStrategy, holdingsBySymbol), "R")}` : "Calculating..."}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 mb-6">
                {(() => {
                  const minInvest = calculateMinInvestment(selectedStrategy, holdingsBySymbol);
                  return minInvest ? (
                    <>
                      <p className="text-2xl font-semibold text-slate-900">
                        {formatCurrency(minInvest, selectedStrategy.currency || 'R')}
                      </p>
                      <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-slate-100 text-slate-500">
                        Min. investment
                      </span>
                    </>
                  ) : selectedStrategy.last_close !== null && selectedStrategy.last_close !== undefined ? (
                    <>
                      <p className="text-2xl font-semibold text-slate-900">
                        {formatCurrency(Math.max(selectedStrategy.last_close, MIN_ASSET_VALUE_DISPLAY), selectedStrategy.currency || 'R')}
                      </p>
                      <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-slate-100 text-slate-500">
                        Min. investment
                      </span>
                    </>
                  ) : null;
                })()}
              </div>

              <div className="mb-5">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-500">
                  <span>{selectedStrategyTimeframe} return</span>
                  <span className={previewPeriodReturn > 0 ? "text-emerald-600" : previewPeriodReturn < 0 ? "text-rose-600" : "text-slate-500"}>
                    {previewPeriodReturn != null ? `${previewPeriodReturn >= 0 ? "+" : ""}${previewPeriodReturn.toFixed(2)}%` : "—"}
                  </span>
                </div>
                <div className="h-44 w-full">
                  {selectedStrategyAnalyticsLoading ? (
                    <div className="flex h-full items-end gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4">
                      {[45, 65, 35, 80, 55, 70, 40, 90, 60, 50, 75, 85].map((h, i) => (
                        <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${h}%` }} />
                      ))}
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={previewChartData}
                        margin={{ top: 12, right: 16, left: 8, bottom: 28 }}
                        onMouseMove={(state) => {
                          if (state?.activeLabel) {
                            setSelectedStrategyActiveLabel(state.activeLabel);
                          }
                        }}
                        onMouseLeave={() => setSelectedStrategyActiveLabel(null)}
                      >
                        <defs>
                          <linearGradient id={previewGradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={previewChartLineColor} stopOpacity={0.25} />
                            <stop offset="70%" stopColor={previewChartLineColor} stopOpacity={0.1} />
                            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <ReferenceLine y={100} stroke="#e2e8f0" strokeDasharray="3 3" />
                        {selectedStrategyActiveLabel ? (
                          <>
                            <ReferenceLine
                              x={selectedStrategyActiveLabel}
                              stroke="#CBD5E1"
                              strokeOpacity={0.6}
                              strokeDasharray="3 3"
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "#ffffff",
                                border: "none",
                                borderRadius: "20px",
                                padding: "3px 8px",
                                boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                              }}
                              labelStyle={{ display: "none" }}
                              formatter={(value) => {
                                if (!previewBaseIndexValue) {
                                  return [`${Number(value).toFixed(2)}`, "Index"];
                                }
                                const delta = ((Number(value) - previewBaseIndexValue) / previewBaseIndexValue) * 100;
                                return [`${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`, "Change"];
                              }}
                              cursor={{ strokeDasharray: "3 3" }}
                            />
                          </>
                        ) : null}
                        <XAxis
                          dataKey="dateLabel"
                          tick={{ fontSize: 11, fill: "#64748b" }}
                          axisLine={{ stroke: "#e2e8f0" }}
                          tickLine={false}
                          height={24}
                        />
                        <YAxis hide domain={previewChartDomain} />
                        <Area
                          type="monotone"
                          dataKey="returnPct"
                          stroke="transparent"
                          fill={`url(#${previewGradientId})`}
                          dot={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="returnPct"
                          stroke={previewChartLineColor}
                          strokeWidth={2}
                          dot={false}
                          activeDot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </div>
                {availablePreviewTimeframes.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {strategyTimeframeOptions.map((option) => {
                      const isDisabled = !availablePreviewTimeframes.includes(option.key);
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setSelectedStrategyTimeframe(option.key)}
                          disabled={isDisabled}
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                            selectedStrategyTimeframe === option.key
                              ? "bg-slate-900 text-white"
                              : "border border-slate-200 bg-white text-slate-600"
                          } ${isDisabled ? "opacity-40 cursor-not-allowed" : ""}`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              
              <div className="flex flex-wrap gap-2 mb-6">
                {(selectedStrategy.tags || [selectedStrategy.risk_level || 'Balanced']).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              {selectedStrategy.holdings && selectedStrategy.holdings.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Top Holdings</p>
                <div className="mt-3 space-y-2">
                  {selectedStrategy.holdings.slice(0, 5).map((holdingItem) => {
                    const ticker = typeof holdingItem === 'string' ? holdingItem : (holdingItem.ticker || holdingItem.symbol);
                    const holding = holdingsSecurities.find(s => s.symbol === ticker);
                    return (
                      <div key={ticker} className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-slate-100 bg-white">
                          {holding?.logo_url ? (
                            <img src={holding.logo_url} alt={ticker} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-slate-100 text-xs font-bold text-slate-600">
                              {ticker?.substring(0, 2)}
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-slate-900">{holding?.name || ticker}</p>
                          <p className="text-xs text-slate-500">{ticker}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              )}

              <button
                onClick={() => {
                  setSelectedStrategy(null);
                  const hArr = getHoldingsArray(selectedStrategy);
                  const enrichedHoldings = hArr.map(h => {
                    const sym = h.ticker || h.symbol || h;
                    const sec = holdingsBySymbol.get(sym) || holdingsBySymbol.get(normalizeSymbol(sym));
                    return { ...h, logo_url: sec?.logo_url || null, shares: getAdjustedShares(h, holdingsBySymbol) };
                  });
                  onOpenFactsheet({ ...selectedStrategy, calculatedMinInvestment: calculateMinInvestment(selectedStrategy, holdingsBySymbol), holdingsWithLogos: enrichedHoldings });
                }}
                className="mt-6 w-full rounded-2xl bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] py-4 font-semibold text-white shadow-lg transition-all active:scale-95"
              >
                View Factsheet
              </button>
            </div>
          </div>
        </div>
      , portalTarget)}

      {/* Filter Sheet */}
      {isFilterOpen && portalTarget && createPortal(
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 px-4 pb-6">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            aria-label="Close filters"
            onClick={() => {
              setIsFilterOpen(false);
              resetSheetPosition();
            }}
          />
          <div
            className="relative z-10 flex h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-[32px] bg-white shadow-2xl"
            style={{ transform: `translateY(${sheetOffset}px)` }}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={handleSheetPointerUp}
            onPointerCancel={handleSheetPointerUp}
          >
            {/* Drag Handle */}
            <div className="flex items-center justify-center pt-3">
              <div className="h-1.5 w-12 rounded-full bg-slate-200" />
            </div>

            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 pb-4 pt-3">
              <h3 className="text-lg font-semibold text-slate-900">
                {viewMode === "openstrategies" ? "Filters" : "Filter & Sort"}
              </h3>
              <button
                type="button"
                onClick={viewMode === "openstrategies" ? clearAllStrategyFilters : clearAllFilters}
                className="text-sm font-semibold text-slate-500"
              >
                Clear all
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {viewMode === "openstrategies" ? (
                /* OpenStrategies Filters */
                <>
                  <div className="space-y-5">
                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Sort</p>
                      <div className="flex flex-wrap gap-2">
                        {strategySortOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setDraftStrategySort(option)}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftStrategySort === option
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Risk level</p>
                      <div className="flex flex-wrap gap-2">
                        {riskOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              setDraftRisks((prev) => {
                                const next = new Set(prev);
                                if (next.has(option)) {
                                  next.delete(option);
                                } else {
                                  next.add(option);
                                }
                                return next;
                              });
                            }}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftRisks.has(option)
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Minimum investment</p>
                      <div className="flex flex-wrap gap-2">
                        {minInvestmentOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setDraftMinInvestment(option)}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftMinInvestment === option
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Asset exposure</p>
                      <div className="flex flex-wrap gap-2">
                        {exposureOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              setDraftExposure((prev) => {
                                const next = new Set(prev);
                                if (next.has(option)) {
                                  next.delete(option);
                                } else {
                                  next.add(option);
                                }
                                return next;
                              });
                            }}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftExposure.has(option)
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Time horizon</p>
                      <div className="flex flex-wrap gap-2">
                        {timeHorizonOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setDraftTimeHorizon(new Set([option]))}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftTimeHorizon.has(option)
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <p className="text-sm font-semibold text-slate-800">Sector</p>
                      <div className="flex flex-wrap gap-2">
                        {strategySectorOptions.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              setDraftStrategySectors((prev) => {
                                const next = new Set(prev);
                                if (next.has(option)) {
                                  next.delete(option);
                                } else {
                                  next.add(option);
                                }
                                return next;
                              });
                            }}
                            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                              draftStrategySectors.has(option)
                                ? "border-transparent bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] text-white"
                                : "border-slate-200 bg-white text-slate-600"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* Invest Filters */
                <>
                  {/* Sort Options */}
                  <section className="mb-6">
                    <h4 className="mb-3 text-sm font-semibold text-slate-700">Sort by</h4>
                    <div className="space-y-2">
                      {sortOptions.map((option) => (
                        <button
                          key={option}
                          onClick={() => setDraftSort(option)}
                          className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition-all ${
                            draftSort === option
                              ? "bg-purple-50 text-purple-700 ring-2 ring-purple-200"
                              : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Sector Filter */}
                  <section className="mb-6">
                    <h4 className="mb-3 text-sm font-semibold text-slate-700">Sector</h4>
                    <div className="flex flex-wrap gap-2">
                      {sectors.map((sector) => (
                        <button
                          key={sector}
                          onClick={() => {
                            const next = new Set(draftSectors);
                            if (next.has(sector)) {
                              next.delete(sector);
                            } else {
                              next.add(sector);
                            }
                            setDraftSectors(next);
                          }}
                          className={`rounded-full px-4 py-2 text-xs font-semibold transition-all ${
                            draftSectors.has(sector)
                              ? "bg-purple-600 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {sector}
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Exchange Filter */}
                  <section className="mb-6">
                    <h4 className="mb-3 text-sm font-semibold text-slate-700">Exchange</h4>
                    <div className="flex flex-wrap gap-2">
                      {exchanges.map((exchange) => (
                        <button
                          key={exchange}
                          onClick={() => {
                            const next = new Set(draftExchanges);
                            if (next.has(exchange)) {
                              next.delete(exchange);
                            } else {
                              next.add(exchange);
                            }
                            setDraftExchanges(next);
                          }}
                          className={`rounded-full px-4 py-2 text-xs font-semibold transition-all ${
                            draftExchanges.has(exchange)
                              ? "bg-purple-600 text-white"
                              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                          }`}
                        >
                          {exchange}
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>

            {/* Apply Button */}
            <div className="sticky bottom-0 border-t border-slate-100 bg-white px-5 pb-5 pt-3">
              <div className="pointer-events-none absolute left-0 right-0 top-0 h-6 bg-gradient-to-b from-white to-transparent" />
              <button
                type="button"
                onClick={() => {
                  if (viewMode === "openstrategies") {
                    applyStrategyFilters();
                  } else {
                    applyFilters();
                  }
                  resetSheetPosition();
                }}
                className="relative w-full rounded-2xl bg-gradient-to-r from-[#111111] via-[#3b1b7a] to-[#5b21b6] py-3 text-sm font-semibold text-white shadow-lg shadow-violet-200/60"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      , portalTarget)}
    </div>
  );
};

export default MarketsPage;
