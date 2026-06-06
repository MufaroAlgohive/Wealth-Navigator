import { Routes, Route, Navigate } from "react-router-dom";
import { useRole } from "@/contexts/RoleContext";

import Dashboard from "@/pages/Dashboard";
import StrategistDashboard from "@/pages/StrategistDashboard";
import StrategistStrategies from "@/pages/StrategistStrategies";
import AdminDashboard from "@/pages/AdminDashboard";
import BusinessDashboard from "@/pages/BusinessDashboard";
import BusinessMembers from "@/pages/BusinessMembers";
import BusinessInsurance from "@/pages/BusinessInsurance";
import Clients from "@/pages/Clients";
import ClientDetail from "@/pages/ClientDetail";
import Marketplace from "@/pages/Marketplace";
import Compliance from "@/pages/Compliance";
import Commissions from "@/pages/Commissions";
import NotFound from "@/pages/NotFound";

import FCOverview from "@/pages/fc/FCOverview";
import FCGroups from "@/pages/fc/FCGroups";
import FCGroupDetail from "@/pages/fc/FCGroupDetail";
import FCOnboarding from "@/pages/fc/FCOnboarding";
import FCMemberDetail from "@/pages/fc/FCMemberDetail";
import FCPayments from "@/pages/fc/FCPayments";
import FCCompliance from "@/pages/fc/FCCompliance";
import FCClaims from "@/pages/fc/FCClaims";
import FCDistributors from "@/pages/fc/FCDistributors";
import OEMSShell from "@/components/oems/OEMSShell";
import OEMSCockpit from "@/pages/oems/OEMSCockpit";
import OEMSBlotter from "@/pages/oems/OEMSBlotter";
import OEMSStrategies from "@/pages/oems/OEMSStrategies";
import OEMSEquities from "@/pages/oems/OEMSEquities";
import OEMSFixedIncome from "@/pages/oems/OEMSFixedIncome";
import OEMSMoneyMarket from "@/pages/oems/OEMSMoneyMarket";
import OEMSCurves from "@/pages/oems/OEMSCurves";
import OEMSMacro from "@/pages/oems/OEMSMacro";
import OEMSNews from "@/pages/oems/OEMSNews";
import OEMSSecurity from "@/pages/oems/OEMSSecurity";
import OEMSIntegration from "@/pages/oems/OEMSIntegration";

export default function RoleRouter() {
  const { role } = useRole();

  if (role === "strategist") {
    return (
      <Routes>
        <Route path="/" element={<StrategistDashboard />} />
        <Route path="/strategies" element={<StrategistStrategies />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  if (role === "admin") {
    return (
      <Routes>
        <Route path="/" element={<AdminDashboard />} />
        <Route path="/compliance" element={<Compliance />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/clients/:id" element={<ClientDetail />} />
        <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  if (role === "business") {
    return (
      <Routes>
        <Route path="/" element={<BusinessDashboard />} />
        <Route path="/members" element={<BusinessMembers />} />
        <Route path="/marketplace" element={<Marketplace />} />
        <Route path="/insurance" element={<BusinessInsurance />} />
        <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  if (role === "funeral_cover") {
    return (
      <Routes>
        <Route path="/" element={<FCOverview />} />
        <Route path="/fc/groups" element={<FCGroups />} />
        <Route path="/fc/groups/:id" element={<FCGroupDetail />} />
        <Route path="/fc/onboarding" element={<FCOnboarding />} />
        <Route path="/fc/members/:id" element={<FCMemberDetail />} />
        <Route path="/fc/payments" element={<FCPayments />} />
        <Route path="/fc/compliance" element={<FCCompliance />} />
        <Route path="/fc/claims" element={<FCClaims />} />
        <Route path="/fc/distributors" element={<FCDistributors />} />
        <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  if (role === "oems") {
    return (
      <OEMSShell>
        <Routes>
          <Route path="/" element={<Navigate to="/oems" replace />} />
          <Route path="/oems" element={<OEMSCockpit />} />
          <Route path="/oems/blotter" element={<OEMSBlotter />} />
          <Route path="/oems/strategies" element={<OEMSStrategies />} />
          <Route path="/oems/equities" element={<OEMSEquities />} />
          <Route path="/oems/fixed-income" element={<OEMSFixedIncome />} />
          <Route path="/oems/money-market" element={<OEMSMoneyMarket />} />
          <Route path="/oems/curves" element={<OEMSCurves />} />
          <Route path="/oems/macro" element={<OEMSMacro />} />
          <Route path="/oems/news" element={<OEMSNews />} />
          <Route path="/oems/security" element={<OEMSSecurity />} />
          <Route path="/oems/integration" element={<OEMSIntegration />} />
          <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
          <Route path="/blotter" element={<Navigate to="/oems/blotter" replace />} />
          <Route path="/strategies" element={<Navigate to="/oems/strategies" replace />} />
          <Route path="/equities" element={<Navigate to="/oems/equities" replace />} />
          <Route path="/fixed-income" element={<Navigate to="/oems/fixed-income" replace />} />
          <Route path="/money-market" element={<Navigate to="/oems/money-market" replace />} />
          <Route path="/curves" element={<Navigate to="/oems/curves" replace />} />
          <Route path="/macro" element={<Navigate to="/oems/macro" replace />} />
          <Route path="/news" element={<Navigate to="/oems/news" replace />} />
          <Route path="/security" element={<Navigate to="/oems/security" replace />} />
          <Route path="/integration" element={<Navigate to="/oems/integration" replace />} />
          <Route path="*" element={<Navigate to="/oems" replace />} />
        </Routes>
      </OEMSShell>
    );
  }

  // wealth_manager (default)
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/clients" element={<Clients />} />
      <Route path="/clients/:id" element={<ClientDetail />} />
      <Route path="/marketplace" element={<Marketplace />} />
      <Route path="/commissions" element={<Commissions />} />
      <Route path="/settings" element={<div className="text-muted-foreground">Settings coming soon</div>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
