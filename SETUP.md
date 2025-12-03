# Quick Setup Guide

## Initial Setup

1. **Start Docker services**
   ```bash
   docker-compose up -d
   ```

2. **Backend setup**
   ```bash
   cd backend
   npm install
   npx prisma generate
   npx prisma migrate dev --name init
   ```

3. **Create backend .env file**
   ```bash
   # In backend/ directory
   cat > .env << EOF
   DATABASE_URL="postgresql://root:root@localhost:5432/sellertoolkit?schema=public"
   REDIS_URL="redis://localhost:6379"
   JWT_SECRET="change-this-in-production"
   JWT_EXPIRES_IN="7d"
   PORT=3001
   NODE_ENV=development
   FRONTEND_URL="http://localhost:3000"
   EOF
   ```

4. **Frontend setup**
   ```bash
   cd frontend
   npm install
   ```

5. **Create frontend .env.local file**
   ```bash
   # In frontend/ directory
   echo 'NEXT_PUBLIC_API_URL=http://localhost:3001' > .env.local
   ```

6. **Start development servers**
   ```bash
   # Terminal 1 - Backend
   cd backend
   npm run start:dev

   # Terminal 2 - Frontend
   cd frontend
   npm run dev
   ```

## Verify Setup

- Backend health: http://localhost:3001/api
- Frontend: http://localhost:3000
- Database: `docker exec -it seller-dashboard-postgres psql -U root -d sellertoolkit`
- Redis: `docker exec -it seller-dashboard-redis redis-cli ping`


