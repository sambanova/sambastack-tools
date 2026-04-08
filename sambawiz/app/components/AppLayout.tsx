'use client';

import { useAppContext } from '@/context/AppContext';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Wrench,
  Rocket,
  Bot,
  Home,
  BookOpen,
  MessageCircleQuestion,
  Phone,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import KubeconfigErrorDialog from './KubeconfigErrorDialog';

interface AppLayoutProps {
  children: React.ReactNode;
}

const externalLinks = [
  {
    title: 'Documentation',
    url: 'https://docs.sambanova.ai/docs/en/sambastack/getting-started/introduction',
    icon: BookOpen,
  },
  {
    title: 'Community',
    url: 'https://community.sambanova.ai/',
    icon: MessageCircleQuestion,
  },
  {
    title: 'Contact Us',
    url: 'https://sambanova.ai/contact',
    icon: Phone,
  },
];

export default function AppLayout({ children }: AppLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();

  const getSelectedItem = () => {
    if (pathname === '/') return 'home';
    if (pathname === '/bundle-builder') return 'bundle-builder';
    if (pathname === '/bundle-deployment') return 'bundle-deployment';
    if (pathname === '/playground') return 'playground';
    return 'bundle-builder';
  };
  const selectedItem = getSelectedItem();

  const {
    envVersion,
    envName,
    namespace,
    validationError,
    showErrorDialog,
    helmCommand,
    errorDetails,
    helmVersionError,
    hasNonNumericalSuffix,
    appVersion,
    setShowErrorDialog,
  } = useAppContext();

  const navItems = [
    {
      key: 'bundle-builder',
      label: 'Bundle Builder',
      icon: Wrench,
      path: '/bundle-builder',
      disabled: helmVersionError,
    },
    {
      key: 'bundle-deployment',
      label: 'Bundle Deployment',
      icon: Rocket,
      path: '/bundle-deployment',
      disabled: helmVersionError,
    },
    {
      key: 'playground',
      label: 'Playground',
      icon: Bot,
      path: '/playground',
      disabled: helmVersionError,
    },
  ];

  return (
    <>
      <KubeconfigErrorDialog
        open={showErrorDialog}
        onClose={() => setShowErrorDialog(false)}
        helmCommand={helmCommand}
        errorDetails={errorDetails}
        showUpgradeLink={helmVersionError}
        onUpgrade={() => {
          setShowErrorDialog(false);
          router.push('/?openUpgrade=true');
        }}
      />
      <SidebarProvider>
        <Sidebar collapsible="icon">
          {/* Header — logo */}
          <SidebarHeader>
            <div className="flex h-12 items-center px-2">
              <div className="group-data-[state=collapsed]/sidebar-wrapper:hidden">
                <Image
                  src="/sidebar-logo.svg"
                  alt="SambaNova"
                  width={130}
                  height={34}
                  style={{ width: '130px', height: 'auto' }}
                  priority
                />
              </div>
              <div className="hidden group-data-[state=collapsed]/sidebar-wrapper:flex justify-center w-full">
                <Home className="size-5 text-primary" />
              </div>
            </div>
          </SidebarHeader>

          <SidebarSeparator />

          {/* Main nav */}
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Platform</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navItems.map(({ key, label, icon: Icon, path, disabled }) => (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        isActive={selectedItem === key}
                        disabled={disabled}
                        onClick={() => {
                          if (!disabled) router.push(path);
                        }}
                        tooltip={label}
                        className={cn(disabled && 'opacity-50 cursor-not-allowed')}
                      >
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* Fallback home nav when kubeconfig is invalid */}
            {validationError && pathname !== '/' && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => router.push('/')}
                        tooltip="Go to Home"
                        isActive={selectedItem === 'home'}
                      >
                        <Home />
                        <span>Home</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {/* External resource links — pushed to bottom */}
            <SidebarGroup className="mt-auto">
              <SidebarGroupContent>
                <SidebarMenu>
                  {externalLinks.map(({ title, url, icon: Icon }) => (
                    <SidebarMenuItem key={title}>
                      <SidebarMenuButton
                        tooltip={title}
                        render={
                          <a href={url} target="_blank" rel="noopener noreferrer" />
                        }
                      >
                        <Icon />
                        <span>{title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          {/* Footer — env info + app version */}
          <SidebarSeparator />
          <SidebarFooter className="pb-4 px-2 flex flex-col gap-2">
            {envVersion && envName ? (
              <button
                onClick={() => router.push('/')}
                className="w-full rounded-lg bg-muted border border-border p-3 cursor-pointer transition-all hover:bg-muted/80 hover:scale-[1.02] text-left group-data-[state=collapsed]/sidebar-wrapper:flex group-data-[state=collapsed]/sidebar-wrapper:justify-center"
              >
                <div className="flex items-center justify-center gap-1.5 mb-1 group-data-[state=collapsed]/sidebar-wrapper:mb-0">
                  <Home className="size-4 text-primary shrink-0" />
                  <span className="text-sm font-semibold text-primary group-data-[state=collapsed]/sidebar-wrapper:hidden truncate">
                    {envName}
                  </span>
                </div>
                <p className="text-xs font-medium text-muted-foreground text-center group-data-[state=collapsed]/sidebar-wrapper:hidden">
                  version: {envVersion}{hasNonNumericalSuffix ? '**' : ''}
                </p>
                {namespace && (
                  <p className="text-xs font-medium text-muted-foreground text-center group-data-[state=collapsed]/sidebar-wrapper:hidden">
                    namespace: {namespace}
                  </p>
                )}
              </button>
            ) : null}

            {appVersion && (
              <div className="rounded bg-black/[0.02] p-2 text-center group-data-[state=collapsed]/sidebar-wrapper:hidden">
                <span className="text-[0.7rem] font-medium text-muted-foreground">
                  SambaWiz v{appVersion}
                </span>
              </div>
            )}
          </SidebarFooter>

          <SidebarRail />
        </Sidebar>

        <SidebarInset>
          <header className="flex h-12 items-center border-b px-4 shrink-0">
            <SidebarTrigger className="-ml-1" />
          </header>

          <main className="flex-1 p-6">
            {validationError && (
              <Alert variant="destructive" className="mb-6">
                <AlertDescription>{validationError}</AlertDescription>
              </Alert>
            )}
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}
