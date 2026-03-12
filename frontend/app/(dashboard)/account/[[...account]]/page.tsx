import { UserProfile } from "@clerk/nextjs";

export default function AccountPage() {
  return (
    <div className="flex min-h-screen justify-center py-8">
      <UserProfile
        routing="path"
        path="/account"
        appearance={{
          elements: {
            rootBox: "w-full max-w-4xl",
            card: "shadow-none w-full",
          },
        }}
      />
    </div>
  );
}
