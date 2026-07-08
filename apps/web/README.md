# Open Migration Web Application

React-based web UI for the Open Migration Stack managed edition.

## Features

- **Multi-tenant Dashboard**: Overview of all migrations and system status
- **Migration Wizard**: Step-by-step configuration for new migrations
- **Real-time Monitoring**: Track sync progress and view logs
- **Team Management**: Invite and manage team members
- **Responsive Design**: Works on desktop and mobile devices

## Tech Stack

- **React 18** with TypeScript
- **Vite** for fast development and building
- **React Query** for server state management
- **Zustand** for client state management
- **Tailwind CSS** for styling
- **React Router** for navigation
- **Axios** for HTTP requests
- **Lucide React** for icons

## Getting Started

### Prerequisites

- Node.js 24+
- pnpm package manager
- Running API server (see `apps/api`)

### Installation

1. **Install dependencies:**
```bash
pnpm install
```

2. **Configure environment:**
```bash
cp .env.example .env
```

3. **Start development server:**
```bash
pnpm dev
```

The application will be available at `http://localhost:3000`

## Environment Variables

```bash
# API URL
VITE_API_URL=http://localhost:3001/api

# Authentication
VITE_AUTH_URL=http://localhost:3001/auth
```

## Project Structure

```
apps/web/
├── src/
│   ├── components/        # Reusable UI components
│   │   └── Layout.tsx    # Main application layout
│   ├── pages/            # Page components
│   │   ├── Dashboard.tsx
│   │   ├── Mappings.tsx
│   │   ├── CreateMapping.tsx
│   │   ├── MappingDetail.tsx
│   │   ├── Tenants.tsx
│   │   ├── Settings.tsx
│   │   └── Login.tsx
│   ├── services/         # API services
│   │   ├── api.ts        # Axios client
│   │   └── mapping-service.ts
│   ├── stores/           # Zustand stores
│   │   ├── auth-store.ts
│   │   └── mapping-store.ts
│   ├── App.tsx           # Main app component
│   ├── index.css         # Tailwind styles
│   └── index.tsx         # Entry point
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
└── README.md
```

## Available Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm preview` - Preview production build
- `pnpm lint` - Run ESLint
- `pnpm test` - Run tests

## Key Components

### Dashboard
Overview page showing:
- Statistics (total, active, completed, error mappings)
- Recent activity
- Quick actions

### Migration Wizard
Multi-step wizard for creating new migrations:
1. **Source**: Select source system (IMAP, OAuth2, Graph)
2. **Target**: Select target system (JMAP, IMAP, CalDAV, etc.)
3. **Credentials**: Enter connection details
4. **Data Types**: Choose what to migrate (email, calendar, contacts, files)
5. **Schedule**: Set sync frequency
6. **Review**: Confirm and create

### Mappings List
View and manage all migrations:
- Filter by status
- Trigger manual sync
- View run history
- Edit or delete mappings

## Authentication

The web app uses JWT authentication:
1. User logs in with email/password
2. Server returns JWT token
3. Token stored in localStorage
4. Token sent with every API request
5. Token automatically refreshed on expiration

## State Management

### Server State (React Query)
- Automatic caching and deduplication
- Background refetching
- Optimistic updates
- Error handling

### Client State (Zustand)
- Authentication state
- Mapping selection
- UI state

## Styling

The app uses Tailwind CSS with a custom design system:
- Custom color palette (primary, success, warning, danger)
- Component classes (btn, card, input, badge)
- Responsive design (mobile-first)
- Dark mode support

## Development Guidelines

### Component Structure
```tsx
import React from 'react';

interface Props {
  // Define props
}

const Component: React.FC<Props> = ({ prop1, prop2 }) => {
  // Component logic
  
  return (
    // JSX
  );
};

export default Component;
```

### API Calls
```tsx
import { useQuery, useMutation } from '@tanstack/react-query';
import { mappingApi } from '../services/mapping-service';

const MyComponent = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['mappings'],
    queryFn: mappingApi.list,
  });

  const mutation = useMutation({
    mutationFn: mappingApi.create,
    onSuccess: () => {
      // Handle success
    },
  });

  // Use data and mutation
};
```

### State Management
```tsx
import { useAuthStore } from '../stores/auth-store';

const MyComponent = () => {
  const { isAuthenticated, user, logout } = useAuthStore();
  
  // Use state
};
```

## Testing

```bash
# Run tests
pnpm test

# Run with coverage
pnpm test:coverage
```

## Production Deployment

### Build
```bash
pnpm build
```

This creates optimized static files in `dist/`.

### Serve
```bash
pnpm preview
```

### Docker
```bash
docker build -t openmigrate-web -f apps/web/Dockerfile .
docker run -p 3000:80 openmigrate-web
```

## Browser Support

- Chrome/Edge (latest 2 versions)
- Firefox (latest 2 versions)
- Safari (latest 2 versions)
- Mobile Safari (iOS 14+)
- Chrome Mobile (latest 2 versions)

## Contributing

1. Create a feature branch
2. Make your changes
3. Run `pnpm lint` and `pnpm test`
4. Submit a pull request

## License

Apache-2.0

---

*This web application is part of the Open Migration Stack, an open-source project for sovereign email/data migration.*
