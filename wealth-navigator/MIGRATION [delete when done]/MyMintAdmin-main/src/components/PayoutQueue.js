import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

const PayoutQueue = () => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const [processingIds, setProcessingIds] = useState(new Set());

  const fetchPending = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('loan_application')
      .select(`
        *,
        profiles:user_id (first_name, last_name, email)
      `)
      .eq('status', 'pending_payout')
      .order('created_at', { ascending: false });

    if (!error) setRequests(data);
    setLoading(false);
  };

  useEffect(() => {
    // Initial Fetch
    fetchPending();

    // Realtime Subscription
    const subscription = supabase
      .channel('payout-updates')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'loan_application' }, 
        payload => {
          if (payload.eventType === 'INSERT' && payload.new.status === 'pending_payout') {
            setRequests(prev => [payload.new, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            if (payload.new.status !== 'pending_payout') {
              setRequests(prev => prev.filter(r => r.id !== payload.new.id));
            } else {
              setRequests(prev => prev.map(r => r.id === payload.new.id ? payload.new : r));
            }
          }
        }
      )
      .subscribe();

    return () => supabase.removeChannel(subscription);
  }, []);

  const handleExecuteEFT = async (loanId, amount) => {
    if (processingIds.has(loanId)) return;
    
    setProcessingIds(prev => new Set(prev).add(loanId));
    try {
      const response = await fetch('/api/disburse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionStorage.getItem('supabase.auth.token')}`
        },
        body: JSON.stringify({
          loanId,
          amount,
          idempotency_key: loanId, // Use loanId as idempotency key
          bank_acc: 'MOCKED_BANK_ACC'
        })
      });

      const result = await response.json();
      if (result.ok) {
        alert("EFT Released Successfully");
        fetchPending();
      } else {
        alert("Error: " + (result.details || result.error));
      }
    } catch (err) {
      alert("Failed to execute EFT");
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(loanId);
        return next;
      });
    }
  };

  if (loading) return <div className="p-6">Loading Payout Queue...</div>;

  return (
    <div className="p-6 bg-purple-50 min-h-screen">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-2xl font-bold text-purple-900 mb-6">Pending EFT Payouts</h2>
        
        <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-purple-100">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-purple-900 text-white">
              <tr>
                <th className="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider">Client</th>
                <th className="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider">Amount (ZAR)</th>
                <th className="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider">LTV %</th>
                <th className="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider">Method</th>
                <th className="px-6 py-4 text-left text-sm font-semibold uppercase tracking-wider text-right">Action</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {requests.length === 0 ? (
                <tr>
                  <td colSpan="5" className="px-6 py-12 text-center text-gray-500 italic">
                    No pending payouts in the queue.
                  </td>
                </tr>
              ) : (
                requests.map(req => (
                  <tr key={req.id} className="hover:bg-purple-25 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        {req.profiles?.first_name} {req.profiles?.last_name}
                      </div>
                      <div className="text-xs text-gray-500">{req.profiles?.email}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                      R {parseFloat(req.principal_amount).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                        req.ltv_at_report > 80 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {req.ltv_at_report}%
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {req.payout_method || 'EFT'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button 
                        onClick={() => handleExecuteEFT(req.id, req.principal_amount)} 
                        disabled={processingIds.has(req.id)}
                        className={`px-6 py-2 rounded-xl transition-all shadow-md active:scale-95 ${
                          processingIds.has(req.id) 
                            ? 'bg-gray-400 cursor-not-allowed text-gray-200' 
                            : 'bg-green-600 hover:bg-green-700 text-white shadow-green-200'
                        }`}
                      >
                        {processingIds.has(req.id) ? (
                          <span className="flex items-center gap-2">
                            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></span>
                            Processing...
                          </span>
                        ) : 'Release Funds'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default PayoutQueue;
