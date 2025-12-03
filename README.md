# Seller Dashboard (SellerToolkit Clone)

A modern e-commerce seller dashboard for managing multi-marketplace operations (Amazon, eBay, Walmart, etc.)

## 🏗️ Architecture

- **Frontend**: Next.js 16 + TypeScript + TailwindCSS
- **Backend**: NestJS + TypeScript
- **Database**: PostgreSQL (via Prisma ORM)
- **Cache/Queue**: Redis
- **Infrastructure**: Docker Compose for local development

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- npm or yarn

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd seller-dashboard
   ```

2. **Start PostgreSQL and Redis**
   ```bash
   docker-compose up -d
   ```

3. **Set up Backend**
   ```bash
   cd backend
   
   # Create .env file (copy from .env.example if needed)
   # DATABASE_URL="postgresql://root:root@localhost:5432/sellertoolkit?schema=public"
   # REDIS_URL="redis://localhost:6379"
   # JWT_SECRET="your-secret-key"
   # PORT=3001
   
   # Install dependencies
   npm install
   
   # Generate Prisma Client
   npx prisma generate
   
   # Run migrations
   npx prisma migrate dev --name init
   
   # Start dev server
   npm run start:dev
   ```

4. **Set up Frontend**
   ```bash
   cd frontend
   
   # Create .env.local file
   # NEXT_PUBLIC_API_URL=http://localhost:3001
   
   # Install dependencies
   npm install
   
   # Start dev server
   npm run dev
   ```

5. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001/api

## 📁 Project Structure

```
seller-dashboard/
├── backend/
│   ├── src/
│   │   ├── prisma/          # Prisma service & module
│   │   ├── redis/           # Redis service & module
│   │   ├── auth/            # Authentication module (TODO)
│   │   ├── products/        # Products module (TODO)
│   │   ├── orders/          # Orders module (TODO)
│   │   ├── inventory/       # Inventory module (TODO)
│   │   └── app.module.ts
│   ├── prisma/
│   │   └── schema.prisma    # Database schema
│   └── package.json
├── frontend/
│   ├── app/                 # Next.js app directory
│   └── package.json
└── docker-compose.yml        # PostgreSQL + Redis
```

## 🗄️ Database Schema

The MVP includes:

- **Users**: Seller accounts
- **SellerAccounts**: Marketplace connections (Amazon, eBay, etc.)
- **Products**: SKUs, ASINs, product details
- **Orders**: Order history with profit calculations
- **Inventory**: Current stock levels

## 🔐 Environment Variables

### Backend (.env)
```env
DATABASE_URL=postgresql://root:root@localhost:5432/sellertoolkit?schema=public
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### Frontend (.env.local)
```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## 📝 Next Steps

1. ✅ Database schema created
2. ✅ Prisma + Redis configured
3. ⏳ Authentication module
4. ⏳ Products CRUD
5. ⏳ Orders ingestion service
6. ⏳ Dashboard UI
7. ⏳ Marketplace API integrations (Amazon SP-API, eBay, etc.)

## 🛠️ Development

- Backend runs on port 3001
- Frontend runs on port 3000
- PostgreSQL on port 5432
- Redis on port 6379

## 📚 Tech Stack Details

- **NestJS**: Modular, scalable backend framework
- **Prisma**: Type-safe database ORM
- **Next.js**: React framework with SSR
- **PostgreSQL**: Robust relational database
- **Redis**: Caching and job queues
