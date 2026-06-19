import React, { useId, useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronRight, Search, SlidersHorizontal, Heart, X } from "lucide-react";
import { saveOpenStrategiesFilters, loadOpenStrategiesFilters, buildChipsFromFilters } from "../lib/usePersistedFilters.js";
import { StrategyReturnHeaderChart } from "../components/StrategyReturnHeaderChart";
import { ChartContainer } from "../components/ui/line-charts-2";
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer } from "recharts";
import { supabase } from "../lib/supabase";
import { getStrategiesWithMetrics, formatChangePct, formatChangeAbs, getChangeColor } from "../lib/strategyData.js";
import { formatCurrency } from "../lib/formatCurrency";
import { normalizeSymbol, getHoldingsArray, getHoldingSymbol, buildHoldingsBySymbol, getStrategyHoldingsSnapshot, calculateMinInvestment, getAdjustedShares } from "../lib/strategyUtils";

const sortOptions = [
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
const sectorOptions = ["Technology", "Consumer", "Healthcare", "Energy", "Financials"];

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

const OpenStrategiesPage = ({ onBack, onOpenFactsheet }) => {
  const [strategies, setStrategies] = useState([]);
  const [portalTarget, setPortalTarget] = useState(null);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedHolding, setSelectedHolding] = useState(null);
  const _savedFilters = useMemo(() => loadOpenStrategiesFilters(), []);
  const [activeChips, setActiveChips] = useState(() => _savedFilters ? buildChipsFromFilters(_savedFilters) : []);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [selectedSort, setSelectedSort] = useState(_savedFilters?.sort || "Recommended");
  const [selectedRisks, setSelectedRisks] = useState(_savedFilters?.risks || new Set());
  const [selectedMinInvestment, setSelectedMinInvestment] = useState(_savedFilters?.minInvestment ?? null);
  const [selectedExposure, setSelectedExposure] = useState(_savedFilters?.exposure || new Set());
  const [selectedTimeHorizon, setSelectedTimeHorizon] = useState(_savedFilters?.timeHorizon || new Set());
  const [selectedSectors, setSelectedSectors] = useState(_savedFilters?.sectors || new Set());
  const [draftSort, setDraftSort] = useState(_savedFilters?.sort || "Recommended");
  const [draftRisks, setDraftRisks] = useState(_savedFilters?.risks || new Set());
  const [draftMinInvestment, setDraftMinInvestment] = useState(_savedFilters?.minInvestment ?? null);
  const [draftExposure, setDraftExposure] = useState(_savedFilters?.exposure || new Set());
  const [draftTimeHorizon, setDraftTimeHorizon] = useState(_savedFilters?.timeHorizon || new Set());
  const [draftSectors, setDraftSectors] = useState(_savedFilters?.sectors || new Set());
  const [sheetOffset, setSheetOffset] = useState(0);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [selectedSectorFilter, setSelectedSectorFilter] = useState(null);
  const [watchlist, setWatchlist] = useState(new Set());
  const [holdingsSecurities, setHoldingsSecurities] = useState([]);
  const carouselRef = useRef(null);
  const dragStartY = useRef(null);
  const isDragging = useRef(false);

  useEffect(() => { setPortalTarget(document.body); }, []);

  // Fetch strategies from database
  useEffect(() => {
    let isMounted = true;

    const fetchStrategies = async () => {
      setStrategiesLoading(true);
      
      try {
        const data = await getStrategiesWithMetrics();
        if (isMounted) {
          console.log("✅ Fetched strategies:", data);
          setStrategies(data);
        }
      } catch (error) {
        console.error("Error fetching strategies:", error);
        if (isMounted) {
          setStrategies([]);
        }
      } finally {
        if (isMounted) {
          setStrategiesLoading(false);
        }
      }
    };

    fetchStrategies();

    return () => {
      isMounted = false;
    };
  }, []);

  const holdingsBySymbol = useMemo(() => buildHoldingsBySymbol(holdingsSecurities), [holdingsSecurities]);

  // Fetch securities for strategy holdings with logos
  useEffect(() => {
    let isMounted = true;

    const fetchHoldingsSecurities = async () => {
      if (!supabase || strategies.length === 0) return;

      try {
        // Get all unique tickers from all strategies
        const allTickers = [...new Set(
          strategies
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
              .select("symbol, name, logo_url, last_price")
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

        if (isMounted && merged.length) {
          setHoldingsSecurities(merged);
        }
      } catch (error) {
        console.error("Error fetching holdings securities:", error);
      }
    };

    fetchHoldingsSecurities();

    return () => {
      isMounted = false;
    };
  }, [strategies]);
  
  const series = [
    { label: "Jan", returnPct: 1.2 },
    { label: "Feb", returnPct: 2.0 },
    { label: "Mar", returnPct: 3.1 },
    { label: "Apr", returnPct: 4.5 },
    { label: "May", returnPct: 5.9 },
    { label: "Jun", returnPct: 7.1 },
    { label: "Jul", returnPct: 8.2 },
    { label: "Aug", returnPct: 9.1 },
    { label: "Sep", returnPct: 10.4 },
    { label: "Oct", returnPct: 11.2 },
    { label: "Nov", returnPct: 11.9 },
    { label: "Dec", returnPct: 12.4 },
  ];
  const [returnValue, setReturnValue] = useState(series[series.length - 1]?.returnPct ?? 5.5);
  const allTimeReturn = series[series.length - 1]?.returnPct ?? 12.4;
  const formattedReturn = `${returnValue >= 0 ? "+" : ""}${returnValue.toFixed(2)}%`;
  const formattedAllTimeReturn = `${allTimeReturn >= 0 ? "+" : ""}${allTimeReturn.toFixed(2)}%`;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const strategyData = strategies;
  const holdingSuggestions = useMemo(() => {
    if (!normalizedQuery) return [];
    const suggestions = new Map();
    strategyData.forEach((strategy) => {
      getHoldingsArray(strategy).forEach((holding) => {
        const rawSymbol = holding.ticker || holding.symbol || holding;
        const normalizedSymbol = normalizeSymbol(rawSymbol);
        const security = holdingsBySymbol.get(rawSymbol) || holdingsBySymbol.get(normalizedSymbol);
        if (security) {
          const label = `${security.name} ${security.symbol}`;
          if (
            security.name.toLowerCase().includes(normalizedQuery) ||
            security.symbol.toLowerCase().includes(normalizedQuery)
          ) {
            suggestions.set(security.symbol, {
              ticker: security.symbol,
              name: security.name,
            });
          }
        }
      });
    });
    return Array.from(suggestions.values());
  }, [normalizedQuery, holdingsSecurities, strategyData]);

  const filteredStrategies = useMemo(() => {
    const results = strategyData.filter((strategy) => {
      const matchesName =
        normalizedQuery && !selectedHolding
          ? (strategy.name && strategy.name.toLowerCase().includes(normalizedQuery)) ||
            (strategy.description && strategy.description.toLowerCase().includes(normalizedQuery))
          : true;
      const matchesHolding = selectedHolding
        ? getHoldingsArray(strategy).some((h) => {
            const rawSymbol = h.ticker || h.symbol || h;
            const normalizedSymbol = normalizeSymbol(rawSymbol);
            return rawSymbol === selectedHolding || normalizedSymbol === selectedHolding;
          })
        : true;
      const matchesRisk = selectedRisks.size
        ? selectedRisks.has(strategy.risk_level || strategy.risk)
        : true;
      const minInvest = calculateMinInvestment(strategy, holdingsBySymbol);
      const matchesMinInvestment = selectedMinInvestment
        ? minInvest != null && (
          (minInvest >= 10000 && selectedMinInvestment === "R10,000+") ||
          (minInvest >= 2500 && minInvest < 10000 && selectedMinInvestment === "R2,500+") ||
          (minInvest < 2500 && selectedMinInvestment === "R500+")
        )
        : true;
      const matchesExposure = selectedExposure.size
        ? selectedExposure.has(strategy.exposure)
        : true;
      const matchesTimeHorizon = selectedTimeHorizon.size
        ? selectedTimeHorizon.has(strategy.timeHorizon)
        : true;
      const matchesSector = selectedSectors.size
        ? strategy.sectors.some((sector) => selectedSectors.has(sector))
        : true;
      const matchesSectorFilter = selectedSectorFilter
        ? strategy.sectors.includes(selectedSectorFilter)
        : true;

      return (
        matchesName &&
        matchesHolding &&
        matchesRisk &&
        matchesMinInvestment &&
        matchesExposure &&
        matchesTimeHorizon &&
        matchesSector &&
        matchesSectorFilter
      );
    });

    const sorted = [...results];
    if (selectedSort === "Best performance") {
      sorted.sort((a, b) => b.returnScore - a.returnScore);
    }
    if (selectedSort === "Lowest max drawdown") {
      sorted.sort((a, b) => a.maxDrawdownScore - b.maxDrawdownScore);
    }
    if (selectedSort === "Lowest volatility") {
      sorted.sort((a, b) => a.volatilityScore - b.volatilityScore);
    }
    if (selectedSort === "Lowest minimum") {
      sorted.sort((a, b) => (calculateMinInvestment(a, holdingsBySymbol) || Infinity) - (calculateMinInvestment(b, holdingsBySymbol) || Infinity));
    }
    if (selectedSort === "Most popular") {
      sorted.sort((a, b) => b.popularityScore - a.popularityScore);
    }

    return sorted;
  }, [
    normalizedQuery,
    selectedHolding,
    selectedRisks,
    selectedMinInvestment,
    selectedExposure,
    selectedTimeHorizon,
    selectedSectors,
    selectedSort,
    selectedSectorFilter,
  ]);

  const applyFilters = () => {
    const newRisks = new Set(draftRisks);
    const newExposure = new Set(draftExposure);
    const newTimeHorizon = new Set(draftTimeHorizon);
    const newSectors = new Set(draftSectors);
    setSelectedSort(draftSort);
    setSelectedRisks(newRisks);
    setSelectedMinInvestment(draftMinInvestment);
    setSelectedExposure(newExposure);
    setSelectedTimeHorizon(newTimeHorizon);
    setSelectedSectors(newSectors);
    const chips = [];
    if (draftRisks.size) {
      chips.push(...Array.from(draftRisks));
    }
    if (draftExposure.size) {
      chips.push(...Array.from(draftExposure));
    }
    if (draftMinInvestment) {
      chips.push(draftMinInvestment);
    }
    if (draftTimeHorizon.size) {
      chips.push(...Array.from(draftTimeHorizon));
    }
    if (draftSectors.size) {
      chips.push(...Array.from(draftSectors));
    }
    if (selectedHolding) {
      chips.push(`Holding: ${selectedHolding}`);
    }
    setActiveChips(chips);
    setIsFilterOpen(false);
    saveOpenStrategiesFilters({ sort: draftSort, risks: newRisks, minInvestment: draftMinInvestment, exposure: newExposure, timeHorizon: newTimeHorizon, sectors: newSectors });
  };

  const clearAllFilters = () => {
    setSelectedSort("Recommended");
    setSelectedRisks(new Set());
    setSelectedMinInvestment(null);
    setSelectedExposure(new Set());
    setSelectedTimeHorizon(new Set());
    setSelectedSectors(new Set());
    setDraftSort("Recommended");
    setDraftRisks(new Set());
    setDraftMinInvestment(null);
    setDraftExposure(new Set());
    setDraftTimeHorizon(new Set());
    setDraftSectors(new Set());
    setSelectedHolding(null);
    setSearchQuery("");
    setActiveChips([]);
    saveOpenStrategiesFilters({ sort: "Recommended", risks: new Set(), minInvestment: null, exposure: new Set(), timeHorizon: new Set(), sectors: new Set() });
  };

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

  const removeChip = (chip) => {
    if (chip.startsWith("Holding:")) {
      setSelectedHolding(null);
    } else if (chip.startsWith("R")) {
      setSelectedMinInvestment(null);
    } else if (["Low risk", "Balanced", "Growth", "High risk"].includes(chip)) {
      const next = new Set(selectedRisks);
      next.delete(chip);
      setSelectedRisks(next);
    } else if (["Local", "Global", "Mixed", "Equities", "ETFs"].includes(chip)) {
      const next = new Set(selectedExposure);
      next.delete(chip);
      setSelectedExposure(next);
    } else if (["Short", "Medium", "Long"].includes(chip)) {
      const next = new Set(selectedTimeHorizon);
      next.delete(chip);
      setSelectedTimeHorizon(next);
    } else if (sectorOptions.includes(chip)) {
      const next = new Set(selectedSectors);
      next.delete(chip);
      setSelectedSectors(next);
    }
    setActiveChips((prev) => prev.filter((item) => item !== chip));
  };

  const toggleWatchlist = (strategyName) => {
    const next = new Set(watchlist);
    if (next.has(strategyName)) {
      next.delete(strategyName);
    } else {
      next.add(strategyName);
    }
    setWatchlist(next);
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-[env(safe-area-inset-bottom)] text-slate-900">
      <div className="mx-auto flex w-full max-w-sm flex-col px-3 pb-10 pt-12 md:max-w-md md:px-6">
        <header className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex flex-col items-center">
            <h1 className="text-lg font-semibold">OpenStrategies</h1>
          </div>
          <div className="h-10 w-10" />
        </header>

        <div className="mt-5 space-y-3">
          <div className="relative">
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search strategies or holdings"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (!event.target.value) {
                    setSelectedHolding(null);
                  }
                }}
                className="flex-1 bg-transparent text-sm text-slate-700 outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  setDraftSort(selectedSort);
                  setDraftRisks(new Set(selectedRisks));
                  setDraftMinInvestment(selectedMinInvestment);
                  setDraftExposure(new Set(selectedExposure));
                  setDraftTimeHorizon(new Set(selectedTimeHorizon));
                  setDraftSectors(new Set(selectedSectors));
                  setIsFilterOpen(true);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-white shadow-sm"
                aria-label="Open filters"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </button>
            </div>
            {holdingSuggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-20 rounded-2xl border border-slate-100 bg-white p-2 shadow-lg">
                {holdingSuggestions.map((suggestion) => (
                  <button
                    key={suggestion.ticker}
                    type="button"
                    onClick={() => {
                      setSelectedHolding(suggestion.ticker);
                      setSearchQuery(`${suggestion.name} ${suggestion.ticker}`);
                      setActiveChips((prev) => {
                        const next = prev.filter((chip) => !chip.startsWith("Holding:"));
                        const holdingChip = `Holding: ${suggestion.name}`;
                        return next.includes(holdingChip) ? next : [...next, holdingChip];
                      });
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <span className="font-semibold">{suggestion.name}</span>
                    <span className="text-xs font-semibold text-slate-400">{suggestion.ticker}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>

        <section className="mt-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">View by Sector</h2>
            <div className="relative">
              <select
                value={selectedSectorFilter || ""}
                onChange={(e) => setSelectedSectorFilter(e.target.value || null)}
                className="appearance-none rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 pr-7 cursor-pointer hover:border-slate-300"
              >
                <option value="">All Sectors</option>
                {sectorOptions.map((sector) => (
                  <option key={sector} value={sector}>
                    {sector}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </div>
            </div>
          </div>

          {filteredStrategies.length === 0 ? (
            <div className="rounded-2xl border border-slate-100 bg-white p-6 text-center shadow-sm">
              <p className="text-sm font-semibold text-slate-700">
                No strategies match your filters
              </p>
              <button
                type="button"
                onClick={clearAllFilters}
                className="mt-4 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div
              ref={carouselRef}
              className="flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-2"
              style={{ scrollBehavior: "smooth", WebkitOverflowScrolling: "touch" }}
            >
              {filteredStrategies.map((strategy) => {
                // Calculate display values from strategy_metrics
                const price = strategy.last_close;
                const changePct = strategy.change_pct;
                const changeAbs = strategy.change_abs;
                const hasMetrics = price !== null && price !== undefined;
                const holdings = getHoldingsArray(strategy);
                
                const calculatedMin = calculateMinInvestment(strategy, holdingsBySymbol);
                const minInvestmentValue = calculatedMin || null;
                const minInvestmentText = minInvestmentValue ? `Min. ${formatCurrency(minInvestmentValue, "R")}` : null;

                const sparkline = strategy.sparkline || [20, 22, 21, 24, 26, 25, 28, 30, 29, 32];
                
                return (
                <button
                  key={strategy.id || strategy.name}
                  type="button"
                  onClick={() => setSelectedStrategy(strategy)}
                  className="flex-shrink-0 w-72 rounded-2xl border border-slate-100 bg-white shadow-sm hover:shadow-md hover:border-slate-200 p-4 transition-all snap-center"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="text-left space-y-1">
                      <p className="text-sm font-semibold text-slate-900">{strategy.name}</p>
                      <div>
                        {hasMetrics ? (
                          <>
                            <p className={`text-xs font-semibold ${getChangeColor(changePct)}`}>
                              {formatChangePct(changePct)}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {minInvestmentText}
                            </p>
                          </>
                        ) : (
                          <p className="text-xs text-slate-400">Data updating...</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center rounded-xl bg-slate-50 px-2">
                      <StrategyMiniChart values={sparkline} />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(strategy.tags || [strategy.risk_level || 'Balanced']).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  {holdings.length > 0 && (() => {
                    const snapshot = getStrategyHoldingsSnapshot(strategy, holdingsBySymbol).slice(0, 3);
                    return (
                    <div className="mt-3 flex items-center gap-3">
                      <div className="flex -space-x-2">
                        {snapshot.map((company) => (
                          <div
                            key={`${strategy.name}-${company.symbol}`}
                            className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-white bg-white shadow-sm"
                          >
                            {company.logo_url ? (
                              <img
                                src={company.logo_url}
                                alt={company.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-slate-100 text-[8px] font-bold text-slate-600">
                                {company.symbol?.substring(0, 2)}
                              </div>
                            )}
                          </div>
                        ))}
                        {holdings.length > 3 && (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500">
                          +{holdings.length - 3}
                        </div>
                        )}
                      </div>
                      <span className="text-xs font-semibold text-slate-500">Holdings snapshot</span>
                    </div>
                    );
                  })()}
                </button>
                );
              })}
            </div>
          )}
        </section>
      </div>

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
            className="relative z-10 flex h-[60vh] w-full max-w-sm flex-col overflow-hidden rounded-[32px] bg-white shadow-2xl"
            style={{ transform: `translateY(${sheetOffset}px)` }}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={handleSheetPointerUp}
            onPointerCancel={handleSheetPointerUp}
          >
            <div className="flex items-center justify-center pt-3">
              <div className="h-1.5 w-12 rounded-full bg-slate-200" />
            </div>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 pb-4 pt-3">
              <h3 className="text-lg font-semibold text-slate-900">Filters</h3>
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-sm font-semibold text-slate-500"
              >
                Clear all
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <div className="space-y-3">
                <p className="text-sm font-semibold text-slate-800">Sort</p>
                <div className="flex flex-wrap gap-2">
                  {sortOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDraftSort(option)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                        draftSort === option
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
                      onClick={() =>
                        setDraftRisks((prev) => {
                          const next = new Set(prev);
                          if (next.has(option)) {
                            next.delete(option);
                          } else {
                            next.add(option);
                          }
                          return next;
                        })
                      }
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
                      onClick={() =>
                        setDraftExposure((prev) => {
                          const next = new Set(prev);
                          if (next.has(option)) {
                            next.delete(option);
                          } else {
                            next.add(option);
                          }
                          return next;
                        })
                      }
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
                  {sectorOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() =>
                        setDraftSectors((prev) => {
                          const next = new Set(prev);
                          if (next.has(option)) {
                            next.delete(option);
                          } else {
                            next.add(option);
                          }
                          return next;
                        })
                      }
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                        draftSectors.has(option)
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

            <div className="sticky bottom-0 border-t border-slate-100 bg-white px-5 pb-5 pt-3">
              <div className="pointer-events-none absolute left-0 right-0 top-0 h-6 bg-gradient-to-b from-white to-transparent" />
              <button
                type="button"
                onClick={() => {
                  applyFilters();
                  resetSheetPosition();
                }}
                className="relative w-full rounded-2xl bg-gradient-to-r from-[#111111] via-[#3b1b7a] to-[#5b21b6] py-3 text-sm font-semibold text-white shadow-lg shadow-violet-200/60"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Strategy Preview Modal */}
      {selectedStrategy && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-4 pb-6">
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            aria-label="Close preview"
            onClick={() => setSelectedStrategy(null)}
          />
          
          <div className="relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <button
              type="button"
              onClick={() => setSelectedStrategy(null)}
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-white shadow-sm ring-1 ring-slate-100">
                  <img
                    src="https://s3-symbol-logo.tradingview.com/country/ZA--big.svg"
                    alt="Strategy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-slate-900">{selectedStrategy.name}</h3>
                  <p className="text-sm text-slate-500">
                    {calculateMinInvestment(selectedStrategy, holdingsBySymbol) ? `Min. ${formatCurrency(calculateMinInvestment(selectedStrategy, holdingsBySymbol), "R")}` : "Calculating..."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleWatchlist(selectedStrategy.name)}
                  className={`flex h-9 w-9 items-center justify-center rounded-full transition-all ${
                    watchlist.has(selectedStrategy.name)
                      ? "bg-rose-100 text-rose-600"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  aria-label="Add to watchlist"
                >
                  <Heart className="h-4 w-4" fill={watchlist.has(selectedStrategy.name) ? "currentColor" : "none"} />
                </button>
              </div>

              <div className="flex items-center gap-3">
                {(() => {
                  const minInvest = calculateMinInvestment(selectedStrategy, holdingsBySymbol);
                  if (minInvest) {
                    return (
                      <>
                        <p className="text-2xl font-semibold text-slate-900">
                          {formatCurrency(minInvest, selectedStrategy.currency || 'R')}
                        </p>
                        <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-slate-100 text-slate-500">
                          Min. investment
                        </span>
                      </>
                    );
                  }
                  if (selectedStrategy.last_close !== null && selectedStrategy.last_close !== undefined) {
                    const displayPrice = Math.max(selectedStrategy.last_close, 1000);
                    return (
                      <>
                        <p className="text-2xl font-semibold text-slate-900">
                          {formatCurrency(displayPrice, selectedStrategy.currency || 'R')}
                        </p>
                        <span className="rounded-full px-2.5 py-1 text-xs font-semibold bg-slate-100 text-slate-500">
                          Min. investment
                        </span>
                      </>
                    );
                  }
                  return null;
                })()}
              </div>

              <div className="flex flex-wrap gap-2">
                {(selectedStrategy.tags || [selectedStrategy.risk_level || 'Balanced']).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              {getHoldingsArray(selectedStrategy).length > 0 && (
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-900">Top Holdings</p>
                <div className="space-y-2">
                  {getHoldingsArray(selectedStrategy).slice(0, 5).map((holdingItem) => {
                    const ticker = holdingItem.ticker || holdingItem.symbol || holdingItem;
                    const weight = holdingItem.weight;
                    const security = holdingsSecurities.find((s) => s.symbol === ticker);
                    return (
                      <div key={ticker} className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-slate-50 border border-slate-100">
                          {security?.logo_url ? (
                            <img
                              src={security.logo_url}
                              alt={security.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-xs font-semibold text-slate-400">{ticker.slice(0, 2)}</span>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-slate-900">{security?.name || ticker}</p>
                          <p className="text-xs text-slate-500">{ticker}</p>
                        </div>
                        {weight && <p className="text-sm font-semibold text-slate-600">{weight.toFixed(1)}%</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
              )}

              <button
                type="button"
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
                className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#111111] via-[#3b1b7a] to-[#5b21b6] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-200/70"
              >
                View Factsheet
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      , portalTarget)}
    </div>
  );
};

export default OpenStrategiesPage;
