import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { 
  FolderGit2, 
  Plus, 
  MoreVertical,
  Play,
  Pause,
  Trash2,
  Edit
} from 'lucide-react';
import { mappingApi } from '../services/mapping-service';
import { formatDistanceToNow } from 'date-fns';

const Mappings: React.FC = () => {
  const { data: mappings, isLoading, refetch } = useQuery({
    queryKey: ['mappings'],
    queryFn: mappingApi.list,
  });

  const handleSync = async (mappingId: string, type: 'full' | 'delta') => {
    try {
      await mappingApi.triggerSync(mappingId, type);
      refetch();
    } catch (error) {
      console.error('Failed to trigger sync:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mappings</h1>
          <p className="text-gray-500 mt-1">
            Manage your data migration configurations
          </p>
        </div>
        <Link
          to="/mappings/new"
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5 mr-2" />
          New Mapping
        </Link>
      </div>

      {/* Mappings List */}
      {mappings?.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <FolderGit2 className="w-16 h-16 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No mappings yet</h3>
          <p className="text-gray-500 mb-6">
            Create your first migration to start syncing data between systems
          </p>
          <Link
            to="/mappings/new"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-5 h-5 mr-2" />
            Create Your First Mapping
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Source → Target
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Sync
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {mappings?.map((mapping) => (
                <tr key={mapping.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10 bg-blue-100 rounded-lg flex items-center justify-center">
                        <FolderGit2 className="w-6 h-6 text-blue-600" />
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-medium text-gray-900">{mapping.name}</div>
                        <div className="text-sm text-gray-500">
                          {mapping.syncConfig.domains.join(', ')}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center text-sm text-gray-900">
                      <span className="font-medium">{mapping.sourceType}</span>
                      <span className="mx-2 text-gray-400">→</span>
                      <span className="font-medium">{mapping.targetType}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        mapping.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : mapping.status === 'error'
                          ? 'bg-red-100 text-red-800'
                          : mapping.status === 'paused'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {mapping.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {mapping.lastSyncAt
                      ? formatDistanceToNow(new Date(mapping.lastSyncAt), { addSuffix: true })
                      : 'Never'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex items-center justify-end space-x-2">
                      {mapping.status === 'active' ? (
                        <button
                          onClick={() => handleSync(mapping.id, 'delta')}
                          className="text-blue-600 hover:text-blue-800"
                          title="Trigger sync"
                        >
                          <Play className="w-5 h-5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleSync(mapping.id, 'full')}
                          className="text-green-600 hover:text-green-800"
                          title="Start sync"
                        >
                          <Play className="w-5 h-5" />
                        </button>
                      )}
                      <Link
                        to={`/mappings/${mapping.id}`}
                        className="text-blue-600 hover:text-blue-800"
                      >
                        <Edit className="w-5 h-5" />
                      </Link>
                      <button
                        className="text-red-600 hover:text-red-800"
                        title="Delete"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default Mappings;
