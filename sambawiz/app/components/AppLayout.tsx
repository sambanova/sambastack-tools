'use client';

import { useAppContext } from '@/context/AppContext';
import {
  Box,
  Drawer,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Alert,
} from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import HomeIcon from '@mui/icons-material/Home';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import KubeconfigErrorDialog from './KubeconfigErrorDialog';

const drawerWidth = 240;

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Derive selected item directly from pathname instead of using state
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

  const drawer = (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        pt: 3,
        pb: 3,
      }}
    >
      <Box sx={{ mb: 3, px: 2 }}>
        <Image
          src="/sidebar-logo.svg"
          alt="SambaNova Logo"
          width={150}
          height={40}
          style={{ width: '150px', height: 'auto' }}
          priority
        />
      </Box>

      {/* Top menu items */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <ListItemButton
          selected={selectedItem === 'bundle-builder'}
          disabled={helmVersionError}
          onClick={() => {
            if (!helmVersionError) {
              router.push('/bundle-builder');
            }
          }}
          sx={{
            mx: 2,
            px: 1,
            py: 1.25,
            borderRadius: 2,
            gap: 2,
            '&.Mui-selected': {
              backgroundColor: 'rgb(232, 229, 234)',
              '&:hover': {
                backgroundColor: 'rgb(232, 229, 234)',
              },
            },
            '&:hover': {
              backgroundColor: helmVersionError ? 'transparent' : 'rgb(232, 229, 234)',
              borderRadius: 2,
            },
            '&.Mui-disabled': {
              opacity: 0.5,
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 'auto',
              color: selectedItem === 'bundle-builder' ? 'primary.main' : '#71717A',
            }}
          >
            <BuildIcon />
          </ListItemIcon>
          <ListItemText
            primary="Bundle Builder"
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: selectedItem === 'bundle-builder' ? 600 : 500,
              fontFamily: 'var(--font-geist-sans)',
            }}
          />
        </ListItemButton>

        <ListItemButton
          selected={selectedItem === 'bundle-deployment'}
          disabled={helmVersionError}
          onClick={() => {
            if (!helmVersionError) {
              router.push('/bundle-deployment');
            }
          }}
          sx={{
            mx: 2,
            px: 1,
            py: 1.25,
            borderRadius: 2,
            gap: 2,
            '&.Mui-selected': {
              backgroundColor: 'rgb(232, 229, 234)',
              '&:hover': {
                backgroundColor: 'rgb(232, 229, 234)',
              },
            },
            '&:hover': {
              backgroundColor: helmVersionError ? 'transparent' : 'rgb(232, 229, 234)',
              borderRadius: 2,
            },
            '&.Mui-disabled': {
              opacity: 0.5,
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 'auto',
              color: selectedItem === 'bundle-deployment' ? 'primary.main' : '#71717A',
            }}
          >
            <RocketLaunchIcon />
          </ListItemIcon>
          <ListItemText
            primary="Bundle Deployment"
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: selectedItem === 'bundle-deployment' ? 600 : 500,
              fontFamily: 'var(--font-geist-sans)',
            }}
          />
        </ListItemButton>

        <ListItemButton
          selected={selectedItem === 'playground'}
          disabled={helmVersionError}
          onClick={() => {
            if (!helmVersionError) {
              router.push('/playground');
            }
          }}
          sx={{
            mx: 2,
            px: 1,
            py: 1.25,
            borderRadius: 2,
            gap: 2,
            '&.Mui-selected': {
              backgroundColor: 'rgb(232, 229, 234)',
              '&:hover': {
                backgroundColor: 'rgb(232, 229, 234)',
              },
            },
            '&:hover': {
              backgroundColor: helmVersionError ? 'transparent' : 'rgb(232, 229, 234)',
              borderRadius: 2,
            },
            '&.Mui-disabled': {
              opacity: 0.5,
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 'auto',
              color: selectedItem === 'playground' ? 'primary.main' : '#71717A',
            }}
          >
            <SmartToyIcon />
          </ListItemIcon>
          <ListItemText
            primary="Playground"
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: selectedItem === 'playground' ? 600 : 500,
              fontFamily: 'var(--font-geist-sans)',
            }}
          />
        </ListItemButton>
      </Box>

      {/* Spacer to push version display to bottom */}
      <Box sx={{ flexGrow: 1 }} />

      {/* Fallback home button when kubeconfig validation failed and not on home page */}
      {validationError && pathname !== '/' && (
        <Box
          onClick={() => router.push('/')}
          sx={{
            mx: 2,
            mt: 2,
            p: 1.5,
            borderRadius: 2,
            backgroundColor: 'rgb(232, 229, 234)',
            border: '1px solid rgb(209, 204, 213)',
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            '&:hover': {
              backgroundColor: 'rgb(220, 217, 224)',
              border: '1px solid rgb(199, 194, 203)',
              transform: 'scale(1.02)',
            },
          }}
        >
          <HomeIcon sx={{ fontSize: '1.25rem', color: 'primary.main' }} />
        </Box>
      )}

      {/* Environment version display - clickable to go to home */}
      {envVersion && envName && (
        <Box
          onClick={() => {
            router.push('/');
          }}
          sx={{
            mx: 2,
            mt: 2,
            p: 1.5,
            borderRadius: 2,
            backgroundColor: 'rgb(232, 229, 234)',
            border: '1px solid rgb(209, 204, 213)',
            cursor: 'pointer',
            transition: 'all 0.2s ease-in-out',
            '&:hover': {
              backgroundColor: 'rgb(220, 217, 224)',
              border: '1px solid rgb(199, 194, 203)',
              transform: 'scale(1.02)',
            },
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 0.5 }}>
            <HomeIcon sx={{ fontSize: '1rem', color: 'primary.main', mr: 0.75 }} />
            <Typography
              sx={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'primary.main',
                fontFamily: 'var(--font-geist-sans)',
              }}
            >
              {envName}
            </Typography>
          </Box>
          <Typography
            sx={{
              fontSize: '0.75rem',
              fontWeight: 500,
              color: '#71717A',
              fontFamily: 'var(--font-geist-sans)',
              textAlign: 'center',
            }}
          >
            version: {envVersion}{hasNonNumericalSuffix ? '**' : ''}
          </Typography>
          {namespace && (
            <Typography
              sx={{
                fontSize: '0.75rem',
                fontWeight: 500,
                color: '#71717A',
                fontFamily: 'var(--font-geist-sans)',
                textAlign: 'center',
              }}
            >
              namespace: {namespace}
            </Typography>
          )}
        </Box>
      )}

      {/* App version display */}
      {appVersion && (
        <Box
          sx={{
            mx: 2,
            mt: 1.5,
            mb: 1,
            p: 1,
            borderRadius: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.02)',
            textAlign: 'center',
          }}
        >
          <Typography
            sx={{
              fontSize: '0.7rem',
              fontWeight: 500,
              color: '#71717A',
              fontFamily: 'var(--font-geist-sans)',
            }}
          >
            SambaWiz v{appVersion}
          </Typography>
        </Box>
      )}
    </Box>
  );

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
      <Box sx={{ display: 'flex', minHeight: '100vh', backgroundColor: 'background.default' }}>
        <Drawer
          variant="permanent"
          sx={{
            width: drawerWidth,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: drawerWidth,
              boxSizing: 'border-box',
              border: 'none',
            },
          }}
        >
          {drawer}
        </Drawer>
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
            backgroundColor: 'background.default',
            minHeight: '100vh',
          }}
        >
          {validationError && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {validationError}
            </Alert>
          )}
          {children}
        </Box>
      </Box>
    </>
  );
}
