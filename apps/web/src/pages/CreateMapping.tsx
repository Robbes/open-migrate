import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  ArrowRight, 
  Check, 
  Server,
  Database,
  Settings,
  Clock,
  FileText,
  Calendar,
  Users,
  Folder
} from 'lucide-react';
import { mappingApi } from '../services/mapping-service';
import { useMutation } from '@tanstack/react-query';

type Step = 'source' | 'target' | 'credentials' | 'data-types' | 'schedule' | 'review';

interface FormData {
  name: string;
  sourceType: 'imap' | 'oauth2' | 'graph';
  targetType: 'jmap' | 'imap' | 'caldav' | 'carddav' | 'webdav';
  sourceHost: string;
  sourcePort: number;
  sourceUsername: string;
  sourcePassword: string;
  sourceSsl: boolean;
  targetHost: string;
  targetPort: number;
  targetUsername: string;
  targetPassword: string;
  targetSsl: boolean;
  domains: string[];
  schedule: string;
}

const initialFormData: FormData = {
  name: '',
  sourceType: 'imap',
  targetType: 'jmap',
  sourceHost: '',
  sourcePort: 993,
  sourceUsername: '',
  sourcePassword: '',
  sourceSsl: true,
  targetHost: '',
  targetPort: 443,
  targetUsername: '',
  targetPassword: '',
  targetSsl: true,
  domains: ['email'],
  schedule: '',
};

const steps: { id: Step; name: string; icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { id: 'source', name: 'Source', icon: Server },
  { id: 'target', name: 'Target', icon: Database },
  { id: 'credentials', name: 'Credentials', icon: Settings },
  { id: 'data-types', name: 'Data Types', icon: FileText },
  { id: 'schedule', name: 'Schedule', icon: Clock },
  { id: 'review', name: 'Review', icon: Check },
];

const dataTypes = [
  { id: 'email', name: 'Email', icon: FileText, description: 'Email messages and folders' },
  { id: 'calendar', name: 'Calendar', icon: Calendar, description: 'Events and appointments' },
  { id: 'contact', name: 'Contacts', icon: Users, description: 'Address book entries' },
  { id: 'file', name: 'Files', icon: Folder, description: 'Attachments and documents' },
];

const CreateMapping: React.FC = () => {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [formData, setFormData] = useState<FormData>(initialFormData);

  const createMutation = useMutation({
    mutationFn: mappingApi.create,
    onSuccess: () => {
      navigate('/mappings');
    },
  });

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      // Submit form
      const mappingData = {
        name: formData.name,
        sourceType: formData.sourceType,
        targetType: formData.targetType,
        sourceConfig: {
          host: formData.sourceHost,
          port: formData.sourcePort,
          username: formData.sourceUsername,
          password: formData.sourcePassword,
          useSsl: formData.sourceSsl,
        },
        targetConfig: {
          host: formData.targetHost,
          port: formData.targetPort,
          username: formData.targetUsername,
          password: formData.targetPassword,
          useSsl: formData.targetSsl,
        },
        syncConfig: {
          domains: formData.domains,
          schedule: formData.schedule || '0 2 * * *',
        },
      };
      createMutation.mutate(mappingData);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    } else {
      navigate('/mappings');
    }
  };

  const updateField = (field: keyof FormData, value: string | boolean | string[]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const toggleDomain = (domain: string) => {
    setFormData((prev) => ({
      ...prev,
      domains: prev.domains.includes(domain)
        ? prev.domains.filter((d) => d !== domain)
        : [...prev.domains, domain],
    }));
  };

  const canProceed = () => {
    switch (steps[currentStep].id) {
      case 'source':
        return formData.sourceHost && formData.sourcePort && formData.sourceUsername;
      case 'target':
        return formData.targetHost && formData.targetPort && formData.targetUsername;
      case 'credentials':
        return formData.name.trim() !== '';
      case 'data-types':
        return formData.domains.length > 0;
      case 'schedule':
        return true; // Schedule is optional
      case 'review':
        return true;
      default:
        return false;
    }
  };

  const renderStep = () => {
    switch (steps[currentStep].id) {
      case 'source':
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Select Source System
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {[
                  { id: 'imap', name: 'IMAP', description: 'Standard email protocol' },
                  { id: 'oauth2', name: 'OAuth2', description: 'Modern authentication' },
                  { id: 'graph', name: 'Microsoft Graph', description: 'Office 365 API' },
                ].map((type) => (
                  <button
                    key={type.id}
                    onClick={() => updateField('sourceType', type.id)}
                    className={`p-4 border-2 rounded-lg text-left transition-colors ${
                      formData.sourceType === type.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <p className="font-medium text-gray-900">{type.name}</p>
                    <p className="text-sm text-gray-500 mt-1">{type.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Host
                </label>
                <input
                  type="text"
                  value={formData.sourceHost}
                  onChange={(e) => updateField('sourceHost', e.target.value)}
                  className="input w-full"
                  placeholder="imap.example.com"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Port
                  </label>
                  <input
                    type="number"
                    value={formData.sourcePort}
                    onChange={(e) => updateField('sourcePort', parseInt(e.target.value))}
                    className="input w-full"
                    placeholder="993"
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="sourceSsl"
                    checked={formData.sourceSsl}
                    onChange={(e) => updateField('sourceSsl', e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="sourceSsl" className="ml-2 block text-sm text-gray-700">
                    Use SSL/TLS
                  </label>
                </div>
              </div>
            </div>
          </div>
        );

      case 'target':
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Select Target System
              </h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {[
                  { id: 'jmap', name: 'JMAP', description: 'Modern email protocol' },
                  { id: 'imap', name: 'IMAP', description: 'Standard email protocol' },
                  { id: 'caldav', name: 'CalDAV', description: 'Calendar protocol' },
                  { id: 'carddav', name: 'CardDAV', description: 'Contact protocol' },
                  { id: 'webdav', name: 'WebDAV', description: 'File storage' },
                ].map((type) => (
                  <button
                    key={type.id}
                    onClick={() => updateField('targetType', type.id)}
                    className={`p-4 border-2 rounded-lg text-left transition-colors ${
                      formData.targetType === type.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <p className="font-medium text-gray-900">{type.name}</p>
                    <p className="text-sm text-gray-500 mt-1">{type.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Host
                </label>
                <input
                  type="text"
                  value={formData.targetHost}
                  onChange={(e) => updateField('targetHost', e.target.value)}
                  className="input w-full"
                  placeholder="jmap.example.com"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Port
                  </label>
                  <input
                    type="number"
                    value={formData.targetPort}
                    onChange={(e) => updateField('targetPort', parseInt(e.target.value))}
                    className="input w-full"
                    placeholder="443"
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="targetSsl"
                    checked={formData.targetSsl}
                    onChange={(e) => updateField('targetSsl', e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="targetSsl" className="ml-2 block text-sm text-gray-700">
                    Use SSL/TLS
                  </label>
                </div>
              </div>
            </div>
          </div>
        );

      case 'credentials':
        return (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Migration Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="input w-full"
                placeholder="My Migration"
              />
              <p className="mt-1 text-sm text-gray-500">
                A friendly name to identify this migration
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h4 className="font-medium text-blue-900 mb-2">Credentials</h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Source Username
                  </label>
                  <input
                    type="text"
                    value={formData.sourceUsername}
                    onChange={(e) => updateField('sourceUsername', e.target.value)}
                    className="input w-full"
                    placeholder="user@example.com"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Source Password
                  </label>
                  <input
                    type="password"
                    value={formData.sourcePassword}
                    onChange={(e) => updateField('sourcePassword', e.target.value)}
                    className="input w-full"
                    placeholder="••••••••"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Target Username
                  </label>
                  <input
                    type="text"
                    value={formData.targetUsername}
                    onChange={(e) => updateField('targetUsername', e.target.value)}
                    className="input w-full"
                    placeholder="user@example.com"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Target Password
                  </label>
                  <input
                    type="password"
                    value={formData.targetPassword}
                    onChange={(e) => updateField('targetPassword', e.target.value)}
                    className="input w-full"
                    placeholder="••••••••"
                  />
                </div>
              </div>
            </div>
          </div>
        );

      case 'data-types':
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900">
              Select Data Types to Migrate
            </h3>
            <p className="text-sm text-gray-500">
              Choose which types of data you want to migrate
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {dataTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => toggleDomain(type.id)}
                  className={`p-4 border-2 rounded-lg text-left transition-colors ${
                    formData.domains.includes(type.id)
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center">
                    <type.icon
                      className={`w-6 h-6 mr-3 ${
                        formData.domains.includes(type.id)
                          ? 'text-blue-600'
                          : 'text-gray-400'
                      }`}
                    />
                    <div>
                      <p className="font-medium text-gray-900">{type.name}</p>
                      <p className="text-sm text-gray-500">{type.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );

      case 'schedule':
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Sync Schedule
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Choose how often to sync data between source and target
              </p>

              <div className="space-y-3">
                {[
                  { value: '0 * * * *', label: 'Hourly', description: 'Every hour' },
                  { value: '0 2 * * *', label: 'Daily', description: 'Every day at 2 AM' },
                  { value: '0 */6 * * *', label: 'Every 6 hours', description: 'Six times per day' },
                  { value: '*/15 * * * *', label: 'Every 15 minutes', description: 'Frequent sync' },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => updateField('schedule', option.value)}
                    className={`w-full p-4 border-2 rounded-lg text-left transition-colors ${
                      formData.schedule === option.value
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <p className="font-medium text-gray-900">{option.label}</p>
                    <p className="text-sm text-gray-500">{option.description}</p>
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Custom Cron Expression (optional)
                </label>
                <input
                  type="text"
                  value={formData.schedule}
                  onChange={(e) => updateField('schedule', e.target.value)}
                  className="input w-full"
                  placeholder="0 2 * * *"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Leave empty for default daily sync at 2 AM
                </p>
              </div>
            </div>
          </div>
        );

      case 'review':
        return (
          <div className="space-y-6">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center">
                <Check className="w-5 h-5 text-green-600 mr-2" />
                <h3 className="font-medium text-green-900">Ready to create migration</h3>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">Migration Details</h4>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-gray-500">Name</dt>
                    <dd className="text-sm font-medium text-gray-900">{formData.name}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-gray-500">Source</dt>
                    <dd className="text-sm font-medium text-gray-900">
                      {formData.sourceType} ({formData.sourceHost}:{formData.sourcePort})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-gray-500">Target</dt>
                    <dd className="text-sm font-medium text-gray-900">
                      {formData.targetType} ({formData.targetHost}:{formData.targetPort})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-gray-500">Schedule</dt>
                    <dd className="text-sm font-medium text-gray-900">
                      {formData.schedule || 'Daily at 2 AM'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">Data Types</h4>
                <div className="flex flex-wrap gap-2">
                  {formData.domains.map((domain) => (
                    <span
                      key={domain}
                      className="px-3 py-1 bg-blue-100 text-blue-800 text-sm font-medium rounded-full"
                    >
                      {domain}
                    </span>
                  ))}
                </div>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-800">
                  <strong>Note:</strong> The initial sync may take some time depending on the amount of data.
                  Subsequent syncs will only transfer changes.
                </p>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Create Migration</h1>
        <p className="text-gray-500 mt-1">
          Set up a new data migration between systems
        </p>
      </div>

      {/* Progress Steps */}
      <nav aria-label="Progress">
        <ol className="flex items-center">
          {steps.map((step, index) => (
            <li key={step.id} className={`relative ${index !== steps.length - 1 ? 'flex-1' : ''}`}>
              <div
                className={`flex items-center ${
                  index <= currentStep ? 'text-blue-600' : 'text-gray-400'
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${
                    index < currentStep
                      ? 'bg-blue-600 border-blue-600'
                      : index === currentStep
                      ? 'bg-white border-blue-600'
                      : 'bg-white border-gray-300'
                  }`}
                >
                  {index < currentStep ? (
                    <Check className="w-5 h-5 text-white" />
                  ) : (
                    <step.icon className="w-5 h-5" />
                  )}
                </div>
                <span className="ml-2 text-sm font-medium">{step.name}</span>
              </div>
              {index !== steps.length - 1 && (
                <div
                  className={`absolute top-4 left-0 right-0 h-0.5 ${
                    index < currentStep ? 'bg-blue-600' : 'bg-gray-200'
                  }`}
                  style={{ left: '4rem' }}
                />
              )}
            </li>
          ))}
        </ol>
      </nav>

      {/* Step Content */}
      <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
        {renderStep()}
      </div>

      {/* Navigation Buttons */}
      <div className="mt-6 flex justify-between">
        <button
          onClick={handleBack}
          className="flex items-center px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft className="w-5 h-5 mr-2" />
          {currentStep === 0 ? 'Cancel' : 'Back'}
        </button>

        <button
          onClick={handleNext}
          disabled={!canProceed() || createMutation.isLoading}
          className="flex items-center px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {createMutation.isLoading ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2" />
              Creating...
            </>
          ) : (
            <>
              {currentStep === steps.length - 1 ? 'Create Migration' : 'Next'}
              <ArrowRight className="w-5 h-5 ml-2" />
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default CreateMapping;
