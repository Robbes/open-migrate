import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, TrendingUp, DollarSign, FileText } from 'lucide-react';
import { billingApi, type Invoice } from '../services/billing-service';

const Billing: React.FC = () => {
  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ['billing-usage'],
    queryFn: () => billingApi.getCurrentUsage(),
  });

  const { data: invoices, isLoading: invoicesLoading } = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => billingApi.listInvoices(),
  });

  if (usageLoading || invoicesLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing</h1>
        <p className="text-gray-500 mt-1">
          Manage your subscription, usage, and payments
        </p>
      </div>

      {/* Current Usage */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Current Usage</h2>
        
        {usage ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <div className="flex items-center">
                  <TrendingUp className="w-5 h-5 text-blue-600 mr-2" />
                  <div>
                    <p className="text-sm text-gray-600">Storage</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {usage.usage.storageUsedGB.toFixed(1)} GB
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-green-50 rounded-lg">
                <div className="flex items-center">
                  <DollarSign className="w-5 h-5 text-green-600 mr-2" />
                  <div>
                    <p className="text-sm text-gray-600">Data Transfer</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {usage.usage.egressGB.toFixed(1)} GB
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-purple-50 rounded-lg">
                <div className="flex items-center">
                  <CreditCard className="w-5 h-5 text-purple-600 mr-2" />
                  <div>
                    <p className="text-sm text-gray-600">Compute Time</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {usage.usage.computeHours.toFixed(1)} hours
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-yellow-50 rounded-lg">
                <div className="flex items-center">
                  <FileText className="w-5 h-5 text-yellow-600 mr-2" />
                  <div>
                    <p className="text-sm text-gray-600">Syncs</p>
                    <p className="text-lg font-semibold text-gray-900">
                      {usage.usage.syncCount}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Cost Breakdown */}
            <div className="mt-6 p-4 bg-gray-50 rounded-lg">
              <h3 className="font-medium text-gray-900 mb-3">Cost Breakdown</h3>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Base Fee</span>
                  <span className="font-medium">€{(usage.currentCost.subtotal / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Storage Cost</span>
                  <span className="font-medium">€{(usage.currentCost.storage / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Data Transfer</span>
                  <span className="font-medium">€{(usage.currentCost.egress / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Compute</span>
                  <span className="font-medium">€{(usage.currentCost.compute / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm pt-2 border-t">
                  <span className="font-medium">Subtotal</span>
                  <span className="font-medium">€{(usage.currentCost.subtotal / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">VAT (21%)</span>
                  <span className="font-medium">€{(usage.currentCost.tax / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-lg font-semibold pt-2 border-t">
                  <span>Total</span>
                  <span className="text-blue-600">€{(usage.currentCost.total / 100).toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-gray-500">No usage data available yet</p>
        )}
      </div>

      {/* Invoices */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Invoices</h2>
        </div>
        <div className="p-6">
          {invoices?.invoices?.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No invoices yet</p>
          ) : (
            <div className="space-y-4">
              {invoices?.invoices?.map((invoice: Invoice) => (
                <div
                  key={invoice.id}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-lg"
                >
                  <div>
                    <p className="font-medium text-gray-900">
                      Invoice {invoice.id}
                    </p>
                    <p className="text-sm text-gray-500">
                      Period: {invoice.period}
                    </p>
                  </div>
                  <div className="flex items-center space-x-4">
                    <span
                      className={`px-2 py-1 text-xs font-semibold rounded-full ${
                        invoice.status === 'paid'
                          ? 'bg-green-100 text-green-800'
                          : invoice.status === 'open'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {invoice.status}
                    </span>
                    <span className="font-medium text-gray-900">
                      €{(invoice.total / 100).toFixed(2)}
                    </span>
                    <button className="text-blue-600 hover:text-blue-800 text-sm font-medium">
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Payment Methods */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Payment Methods</h2>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
            Add Payment Method
          </button>
        </div>
        <div className="p-6">
          <p className="text-gray-500 text-center py-8">
            No payment methods configured yet
          </p>
        </div>
      </div>
    </div>
  );
};

export default Billing;
