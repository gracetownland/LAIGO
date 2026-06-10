import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Box, Typography, Stack, Menu, MenuItem } from "@mui/material";
import GavelOutlinedIcon from "@mui/icons-material/GavelOutlined";
import CreateNewFolderIcon from "@mui/icons-material/CreateNewFolder";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import { signOut } from "aws-amplify/auth";
import { useUser } from "../contexts/UserContext";
import { useRoleLabels } from "../contexts/RoleLabelsContext";
import NotificationButton from "./Notifications/NotificationButton";
import HelpButton from "./Help/HelpButton";

const iconStyle = { color: "var(--text-secondary)", fontSize: "1.5rem" };
const labelStyle = {
  color: "var(--text-secondary)",
  fontSize: "0.7rem",
  marginTop: "4px",
};

type HeaderItemProps = {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
};

const HeaderItem: React.FC<HeaderItemProps> = ({ icon, label, onClick }) => (
  <Stack
    alignItems="center"
    onClick={onClick}
    sx={{
      cursor: "pointer",
      mx: 2,
      p: 1,
      borderRadius: 1,
      transition: "color 0.2s ease",
      "& svg": { transition: "color 0.2s ease" },
      "&:hover": {
        "& svg": { color: "var(--text-secondary)" },
        "& .header-label": { color: "var(--text-secondary)" },
      },
      ...(onClick ? {} : { pointerEvents: "none" }), // Optional safety, though cursor pointer suggests interactive
    }}
  >
    {icon}
    <Typography variant="caption" className="header-label" sx={labelStyle}>
      {label}
    </Typography>
  </Stack>
);

const AdvocateHeader: React.FC = () => {
  const navigate = useNavigate();
  const { userInfo, setActivePerspective, availablePerspectives } = useUser();
  const { singular } = useRoleLabels();
  const [profileMenuAnchor, setProfileMenuAnchor] =
    useState<null | HTMLElement>(null);

  const handleProfileClick = (event: React.MouseEvent<HTMLElement>) => {
    setProfileMenuAnchor(event.currentTarget);
  };

  const handleProfileClose = () => {
    setProfileMenuAnchor(null);
  };

  const handleSignOut = async () => {
    try {
      await signOut({ global: true }); // Revokes refresh token server-side (AUTH-TL-02)
      handleProfileClose();
      window.location.href = "/";
    } catch (error) {
      // Fallback to local signout if global fails (e.g., network error)
      await signOut();
      window.location.href = "/";
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "1rem 2rem",
        backgroundColor: "var(--header)",
        height: "80px",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ cursor: "pointer" }}
        onClick={() => navigate("/")}
      >
        <GavelOutlinedIcon sx={{ color: "var(--primary)", fontSize: 20 }} />
        <Typography
          variant="h6"
          sx={{
            color: "var(--text)",
            fontWeight: 700,
            fontFamily: "var(--font-family)",
          }}
        >
          LAIGO
        </Typography>
      </Stack>

      <Box sx={{ display: "flex", alignItems: "center" }}>
        <HeaderItem
          icon={<CreateNewFolderIcon sx={iconStyle} />}
          label="New Case"
          onClick={() => navigate("/create-case")}
        />
        <HeaderItem
          icon={<FolderOpenOutlinedIcon sx={iconStyle} />}
          label="All Cases"
          onClick={() => navigate("/")}
        />
        <NotificationButton />
        <HelpButton />
        <Stack
          alignItems="center"
          sx={{
            cursor: "pointer",
            mx: 2,
            p: 1,
            borderRadius: 1,
            transition: "color 0.2s ease",
            "& svg": { transition: "color 0.2s ease" },
            "&:hover": {
              "& svg": { color: "var(--text-secondary)" },
              "& .header-label": { color: "var(--text-secondary)" },
            },
          }}
          onClick={handleProfileClick}
        >
          <AccountCircleOutlinedIcon sx={iconStyle} />
          <Typography
            variant="caption"
            className="header-label"
            sx={labelStyle}
          >
            {userInfo?.firstName || "User"}
          </Typography>
        </Stack>
      </Box>

      <Menu
        anchorEl={profileMenuAnchor}
        open={Boolean(profileMenuAnchor)}
        onClose={handleProfileClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        PaperProps={{
          elevation: 0,
          sx: {
            backgroundColor: "var(--header)",
            color: "var(--text)",
            boxShadow: "none",
          },
        }}
      >
        {availablePerspectives
          .filter((p) => p !== "student")
          .map((p) => (
            <MenuItem
              key={p}
              onClick={() => {
                setActivePerspective(p);
                navigate("/");
                handleProfileClose();
              }}
              sx={{
                color: "var(--text)",
                backgroundColor: "inherit",
                fontSize: "0.7rem",
                fontFamily: "var(--font-family)",
                "&:hover": {
                  color: "var(--text-secondary)",
                  backgroundColor: "inherit",
                },
              }}
            >
              Switch to {singular(p)}
            </MenuItem>
          ))}
        <MenuItem
          onClick={handleSignOut}
          sx={{
            color: "var(--text)",
            backgroundColor: "inherit",
            fontSize: "0.7rem",
            fontFamily: "var(--font-family)",
            "&:hover": {
              color: "var(--text-secondary)",
              backgroundColor: "inherit",
            },
          }}
        >
          Sign Out
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default AdvocateHeader;
