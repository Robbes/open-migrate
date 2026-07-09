import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { 
  Activity, 
  Users, 
  Server, 
  TrendingUp, 
  AlertCircle,
  CheckCircle,
  Clock,
  HardDrive
} from 'lucide-react';
import { apiClient } from '../services/api.js';

interface SystemHealth {
  status: 'healthy' | 'degraded' | 'critical';
  uptime: string;
  lastRestart: string;
}

interface TenantStats {
  total: number;
  active: number;
  inactive: number;
  newThisMonth: number;
}

interface MigrationStats {
  total: number;
  running: number;
  completed: number;
  failed: number;
  successRate: number;
}

interface ResourceUsage {
  cpu: number;
  memory: number;
  storage: number;
  databaseConnections: number;
}

interface Revenue {
  total: number;
  thisMonth: number;
  lastMonth: number;
  growth: number;
}

const OperatorDashboard: React.FC = () => {
  const { data: health, isLoading: healthLoading } = useQuery({
    queryKey: ['system-health'],
    queryFn: async () => {
      const response = await apiClient.get('/admin/health');
      return response.data;
    },
  });

  const { data: tenantStats, isLoading: tenantLoading } = useQuery({
    queryKey: ['admin-tenant-stats'],
    queryFn: async () => {
      const response = await apiClient.get('/admin/tenants/stats');
      return response.data;
    },
  });

  const { data: migrationStats, isLoading: migrationLoading } = useQuery({
    queryKey: ['admin-migration-stats'],
    queryFn: async () => {
      const response = await apiClient.get('/admin/migrations/stats');
      return response.data;
    },
  });

  const { data: resources, isLoading: resourcesLoading } = useQuery({
    queryKey: ['admin-resources'],
    queryFn: async () => {
      const response = await apiClient.get('/admin/resources');
      return response.data;
    },
  });

  const { data: revenue, isLoading: revenueLoading } = useQuery({
    queryKey: ['admin-revenue'],
    queryFn: async () => {
      const response = await apiClient.get('/admin/revenue');
      return response.data;
    },
  });

  const formatCurrency = (cents: number) => {
    return `€${(cents / 100).toFixed(2)}`;
  };

  const formatPercent = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Operator Dashboard</h1>
        <p className="text-gray-500 mt-1">
          System monitoring, analytics, and administrative controls
        </p>
      </div>

      {/* System Health */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">System Health</h2>
        
        {healthLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="p-4 bg-green-50 rounded-lg">
              <div className="flex items-center">
                <CheckCircle className="w-5 h-5 text-green-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Status</p>
                  <p className="text-lg font-semibold text-gray-900 capitalize">
                    {health?.status || 'Unknown'}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="flex items-center">
                <Clock className="w-5 h-5 text-blue-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Uptime</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {health?.uptime || 'N/A'}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-purple-50 rounded-lg">
              <div className="flex items-center">
                <Server className="w-5 h-5 text-purple-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Active Jobs</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {migrationStats?.running || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-yellow-50 rounded-lg">
              <div className="flex items-center">
                <AlertCircle className="w-5 h-5 text-yellow-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Last Restart</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {health?.lastRestart || 'Never'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Resource Usage */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Resource Usage</h2>
        
        {resourcesLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-gray-700">CPU Usage</span>
                <span className="text-sm font-medium text-gray-700">
                  {resources?.cpu?.toFixed(1) || 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full" 
                  style={{ width: `${resources?.cpu || 0}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-gray-700">Memory Usage</span>
                <span className="text-sm font-medium text-gray-700">
                  {resources?.memory?.toFixed(1) || 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-green-600 h-2 rounded-full" 
                  style={{ width: `${resources?.memory || 0}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-gray-700">Storage Usage</span>
                <span className="text-sm font-medium text-gray-700">
                  {resources?.storage?.toFixed(1) || 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-purple-600 h-2 rounded-full" 
                  style={{ width: `${resources?.storage || 0}%` }}
                ></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm font-medium text-gray-700">Database Connections</span>
                <span className="text-sm font-medium text-gray-700">
                  {resources?.databaseConnections || 0}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-yellow-600 h-2 rounded-full" 
                  style={{ width: `${(resources?.databaseConnections || 0) * 2}%` }}
                ></div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tenant Statistics */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Tenant Statistics</h2>
        
        {tenantLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="flex items-center">
                <Users className="w-5 h-5 text-blue-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Total Tenants</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {tenantStats?.total || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-50 rounded-lg">
              <div className="flex items-center">
                <Activity className="w-5 h-5 text-green-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Active</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {tenantStats?.active || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-gray-100 rounded-lg">
              <div className="flex items-center">
                <Users className="w-5 h-5 text-gray-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Inactive</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {tenantStats?.inactive || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-purple-50 rounded-lg">
              <div className="flex items-center">
                <TrendingUp className="w-5 h-5 text-purple-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">New This Month</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {tenantStats?.newThisMonth || 0}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Migration Statistics */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Migration Statistics</h2>
        
        {migrationLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="flex items-center">
                <Server className="w-5 h-5 text-blue-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Total</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {migrationStats?.total || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-50 rounded-lg">
              <div className="flex items-center">
                <Activity className="w-5 h-5 text-green-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Running</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {migrationStats?.running || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-purple-50 rounded-lg">
              <div className="flex items-center">
                <CheckCircle className="w-5 h-5 text-purple-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Completed</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {migrationStats?.completed || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-red-50 rounded-lg">
              <div className="flex items-center">
                <AlertCircle className="w-5 h-5 text-red-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Failed</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {migrationStats?.failed || 0}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-yellow-50 rounded-lg">
              <div className="flex items-center">
                <TrendingUp className="w-5 h-5 text-yellow-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Success Rate</p>
                  <p className="text-xl font-semibold text-gray-900">
                    {formatPercent(migrationStats?.successRate || 0)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Revenue Overview */}
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue Overview</h2>
        
        {revenueLoading ? (
          <div className="flex items-center justify-center h-24">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="p-4 bg-green-50 rounded-lg">
              <div className="flex items-center">
                <HardDrive className="w-5 h-5 text-green-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Total Revenue</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {formatCurrency(revenue?.total || 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="flex items-center">
                <TrendingUp className="w-5 h-5 text-blue-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">This Month</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {formatCurrency(revenue?.thisMonth || 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-purple-50 rounded-lg">
              <div className="flex items-center">
                <Activity className="w-5 h-5 text-purple-600 mr-2" />
                <div>
                  <p className="text-sm text-gray-600">Growth</p>
                  <p className="text-2xl font-semibold text-gray-900">
                    {formatPercent(revenue?.growth || 0)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default OperatorDashboard;
