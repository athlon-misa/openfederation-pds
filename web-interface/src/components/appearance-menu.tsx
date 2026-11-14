'use client';

import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { PRESETS } from '@/lib/appearance';
import { useAppearance } from '@/providers/appearance-provider';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function AppearanceMenu() {
  const { preset, setPreset, ready } = useAppearance();
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Appearance: choose theme and color mode" disabled={!ready} className="shrink-0 gap-2">
          <Palette className="size-4" aria-hidden />
          <span className="hidden lg:inline">Appearance</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-label="Theme" value={preset} onValueChange={setPreset}>
          {PRESETS.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span><span className="block font-medium">{item.label}</span><span className="block text-xs text-muted-foreground">{item.description}</span></span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Color mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-label="Color mode" value={theme ?? 'light'} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light"><Sun aria-hidden />Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><Moon aria-hidden />Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system"><Monitor aria-hidden />Use device setting</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
