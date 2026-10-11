import { createFileRoute } from "@tanstack/react-router";
import { PixelStudio } from "@/components/pixel-studio";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <PixelStudio />;
}
