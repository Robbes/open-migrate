import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { 
  FolderGit2, 
  ArrowRightLeft, 
  CheckCircle, 
  AlertCircle,
  Clock,
  Plus
} from 'lucide-react';
import { mappingApi } from '../services/mapping-service';
import { formatDistanceToNow } from 'date-fns';

const Dashboard: React.FC = () => {
  const { data: mappings, isLoading, error } = useQuery({
    queryKey: ['mappings'],
    queryFn: mappingApi.list,
  });

  const stats = React.useMemo(() => {
    if (!mappings) return { total: 0, active: 0, completed: 0, errors: 0 };
    
    return {
      total: mappings.length,
      active: mappings.filter((m) => m.status === 'active').length,
      completed: mappings.filter((m) => m.status === 'completed').length,
      errors: mappings.filter((m) => m.status === 'error').length,
    };
  }, [mappings]);

  const recentRuns = React.useMemo(() => {
    if (!mappings) return [];
    
    return mappings
      .filter((m) => m.lastSyncAt)
      .sort((a, b) => 
        new Date(b.lastSyncAt!).getTime() - new Date(a.lastSyncAt!).getTime()
      )
      .slice(0, 5);
  }, [mappings]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-center">
          <AlertCircle className="w-5 h-5 text-red-600 mr-2" />
          <div>
            <h3 className="text-sm font-medium text-red-800">Error loading dashboard</h3>
            <p className="text-sm text-red-600 mt-1">
              {error instanceof Error ? error.message : 'An unexpected error occurred'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="p-3 bg-blue-100 rounded-lg">
              <FolderGit2 className="w-6 h-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Mappings</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.total}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="p-3 bg-green-100 rounded-lg">
              <ArrowRightLeft className="w-6 h-6 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Active</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.active}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="p-3 bg-emerald-100 rounded-lg">
              <CheckCircle className="w-6 h-6 text-emerald-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Completed</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.completed}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="p-3 bg-red-100 rounded-lg">
              <AlertCircle className="w-6 h-6 text-red-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Errors</p>
              <p className="text-2xl font-semibold text-gray-900">{stats.errors}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
        </div>
        <div className="p-6">
          {recentRuns.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No activity yet</h3>
              <p className="text-gray-500 mb-4">
                Create your first migration to start syncing data
              </p>
              <Link
                to="/mappings/new"
                className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-5 h-5 mr-2" />
                Create Migration
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {recentRuns.map((mapping) => (
                <div
                  key={mapping.id}
                  className="flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <div className="flex items-center space-x-4">
                    <div className={`w-2 h-2 rounded-full ${
                      mapping.status === 'active' ? 'bg-green-500' :
                      mapping.status === 'error' ? 'bg-red-500' :
                      'bg-gray-400'
                    }`} />
                    <div>
                      <p className="font-medium text-gray-900">{mapping.name}</p>
                      <p className="text-sm text-gray-500">
                        {mapping.sourceType} → {mapping.targetType}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-4">
                    <p className="text-sm text-gray-500">
                      Last sync: {mapping.lastSyncAt ? formatDistanceToNow(new Date(mapping.lastSyncAt), { addSuffix: true }) : 'Never'}
                    </p>
                    <Link
                      to={`/mappings/${mapping.id}`}
                      className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    >
                      View →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            to="/mappings/new"
            className="flex items-center p-4 bg-white rounded-lg border border-blue-200 hover:border-blue-300 transition-colors"
          >
            <Plus className="w-5 h-5 text-blue-600 mr-3" />
            <div>
              <p className="font-medium text-gray-900">New Migration</p>
              <p className="text-sm text-gray-500">Create a new data migration</p>
            </div>
          </Link>
          
          <Link
            to="/mappings"
            className="flex items-center p-4 bg-white rounded-lg border border-blue-200 hover:border-blue-300 transition-colors"
          >
            <FolderGit2 className="w-5 h-5 text-blue-600 mr-3" />
            <div>
              <p className="font-medium text-gray-900">View All Mappings</p>
              <p className="text-sm text-gray-500">Manage your migrations</p>
            </div>
          </Link>
          
          <Link
            to="/settings"
            className="flex items-center p-4 bg-white rounded-lg border border-blue-200 hover:border-blue-300 transition-colors"
          >
            <Settings className="w-5 h-5 text-blue-600 mr-3" />
            <div>
              <p className="font-medium text-gray-900">Settings</p>
              <p className="text-sm text-gray-500">Configure your account</p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
