import jarvisPng from "@/assets/hosts/jarvis.png";
import scarlettPng from "@/assets/hosts/scarlett.png";

// Host identities live in one place so the names are easy to change later.
export interface Host {
  id: "jarvis" | "scarlett";
  name: string;
  img: string;
  bio: string;
}

export const JARVIS: Host = {
  id: "jarvis",
  name: "Jarvis",
  img: jarvisPng,
  bio: "Twenty-plus years on the rail, from Saratoga to Santa Anita. Built the Elite Edge handicapping engine to put a sharp's eye on every race card.",
};

export const SCARLETT: Host = {
  id: "scarlett",
  name: "Scarlett",
  img: scarlettPng,
  bio: "Track-side analyst and pace specialist. Reads the paddock, the tote board, and the weather like three pages of the same program.",
};

export const HOSTS: Host[] = [JARVIS, SCARLETT];
