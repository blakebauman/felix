import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { type Theme, useTheme } from './theme-provider';

/**
 * Light / dark / system theme switcher — the analogue of vercel/ai-chatbot's
 * `ModeToggle`. The trigger shows a sun in light mode and a moon in dark; the
 * menu lets you pin a mode or follow the OS.
 */
const OPTIONS: Array<{ value: Theme; label: string; Icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
];

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Toggle theme">
          {resolved === 'dark' ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={cn('gap-2', theme === value && 'font-medium')}
          >
            <Icon className="size-4" />
            {label}
            {theme === value && <span className="ml-auto text-muted-foreground">●</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
