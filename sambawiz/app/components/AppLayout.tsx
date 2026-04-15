'use client';

import { useState, useEffect } from 'react';
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
import TuneIcon from '@mui/icons-material/Tune';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import KubeconfigErrorDialog from './KubeconfigErrorDialog';
import { useAppContext } from '../context/AppContext';

const drawerWidth = 240;

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Derive selected item directly from pathname instead of using state
  const getSelectedItem = () => {
    if (pathname === '/') return 'environment-settings';
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
    helmCommand,
    errorDetails,
    helmVersionError,
    hasNonNumericalSuffix,
  } = useAppContext();

  const [showErrorDialog, setShowErrorDialog] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  // Show error dialog when validation fails
  useEffect(() => {
    if (validationError) {
      setShowErrorDialog(true);
    }
  }, [validationError]);

  // Fetch app version on component mount
  useEffect(() => {
    const fetchAppVersion = async () => {
      try {
        const response = await fetch('/api/app-version');
        const data = await response.json();

        if (data.success) {
          setAppVersion(data.version);
        }
      } catch (error) {
        console.error('Failed to fetch app version:', error);
      }
    };

    fetchAppVersion();
  }, []);

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
            slotProps={{ primary: { fontSize: '0.875rem', fontWeight: selectedItem === 'bundle-builder' ? 600 : 500, fontFamily: 'var(--font-geist-sans)' } }}
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
            slotProps={{ primary: { fontSize: '0.875rem', fontWeight: selectedItem === 'bundle-deployment' ? 600 : 500, fontFamily: 'var(--font-geist-sans)' } }}
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
            slotProps={{ primary: { fontSize: '0.875rem', fontWeight: selectedItem === 'playground' ? 600 : 500, fontFamily: 'var(--font-geist-sans)' } }}
          />
        </ListItemButton>
      </Box>

      {/* Spacer to push version display to bottom */}
      <Box sx={{ flexGrow: 1 }} />

      {/* Environment Settings nav item with env details */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <ListItemButton
          selected={selectedItem === 'environment-settings'}
          onClick={() => router.push('/')}
          sx={{
            mx: 2,
            px: 1,
            py: 1.25,
            borderRadius: 2,
            gap: 2,
            alignItems: 'flex-start',
            '&.Mui-selected': {
              backgroundColor: 'rgb(232, 229, 234)',
              '&:hover': { backgroundColor: 'rgb(232, 229, 234)' },
            },
            '&:hover': {
              backgroundColor: 'rgb(232, 229, 234)',
              borderRadius: 2,
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 'auto',
              color: selectedItem === 'environment-settings' ? 'primary.main' : '#71717A',
              mt: '2px',
            }}
          >
            <TuneIcon />
          </ListItemIcon>
          <Box>
            <Typography
              sx={{
                fontSize: '0.875rem',
                fontWeight: selectedItem === 'environment-settings' ? 600 : 500,
                fontFamily: 'var(--font-geist-sans)',
                color: 'text.primary',
                lineHeight: 1.5,
              }}
            >
              Environment Settings
            </Typography>
            {envName && (
              <Typography
                sx={{
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  color: 'primary.main',
                  fontFamily: 'var(--font-geist-sans)',
                  lineHeight: 1.4,
                }}
              >
                {envName}
              </Typography>
            )}
            {envVersion && (
              <Typography
                sx={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: '#71717A',
                  fontFamily: 'var(--font-geist-sans)',
                  lineHeight: 1.4,
                }}
              >
                version: {envVersion}{hasNonNumericalSuffix ? '**' : ''}
              </Typography>
            )}
            {namespace && (
              <Typography
                sx={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: '#71717A',
                  fontFamily: 'var(--font-geist-sans)',
                  lineHeight: 1.4,
                }}
              >
                namespace: {namespace}
              </Typography>
            )}
          </Box>
        </ListItemButton>
      </Box>

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
