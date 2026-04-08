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
  SlidersHorizontal,
  BookOpen,
  MessageCircleQuestion,
  Phone,
  Server,
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
    if (pathname === '/') return 'environment';
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

  const platformItems = [
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
                <Image
                  src="/favicon.ico"
                  alt="SambaNova"
                  width={24}
                  height={24}
                  style={{ width: '24px', height: '24px' }}
                />
              </div>
            </div>
          </SidebarHeader>

          <SidebarSeparator />

          <SidebarContent>
            {/* Platform — primary tools */}
            <SidebarGroup>
              <SidebarGroupLabel>Platform</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {platformItems.map(({ key, label, icon: Icon, path, disabled }) => (
                    <SidebarMenuItem key={key}>
                      <SidebarMenuButton
                        isActive={selectedItem === key}
                        disabled={disabled}
                        onClick={() => { if (!disabled) router.push(path); }}
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

            {/* Configuration — setup/env, accessed infrequently */}
            <SidebarGroup>
              <SidebarGroupLabel>Configuration</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={selectedItem === 'environment'}
                      onClick={() => router.push('/')}
                      tooltip="Environment"
                    >
                      <SlidersHorizontal />
                      <span>Environment</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            {/* External resource links — pushed to bottom */}
            <SidebarGroup className="mt-auto">
              <SidebarGroupContent>
                <SidebarMenu>
                  {externalLinks.map(({ title, url, icon: Icon }) => (
                    <SidebarMenuItem key={title}>
                      <SidebarMenuButton
                        tooltip={title}
                        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
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

          {/* Footer — active env display (informational only) */}
          <SidebarSeparator />
          <SidebarFooter className="pb-4 px-2 flex flex-col gap-2">
            {envVersion && envName ? (
              <div className="w-full rounded-lg bg-muted border border-border p-3 group-data-[state=collapsed]/sidebar-wrapper:flex group-data-[state=collapsed]/sidebar-wrapper:justify-center">
                <div className="flex items-center justify-center gap-1.5 mb-1 group-data-[state=collapsed]/sidebar-wrapper:mb-0">
                  <Server className="size-4 text-primary shrink-0" />
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
              </div>
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
