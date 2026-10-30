#!/bin/bash
# Template for the host table wake-lab.sh sources. Copy it to ~/.config/wake-lab/hosts.sh (or
# anywhere WAKE_LAB_HOSTS points), fill in the real values, and keep that copy out of git:
#
#   mkdir -p ~/.config/wake-lab
#   cp scripts/wake-lab-hosts.example.sh ~/.config/wake-lab/hosts.sh
#   chmod 600 ~/.config/wake-lab/hosts.sh && $EDITOR ~/.config/wake-lab/hosts.sh
#
# This is the only part of the lab's wiring that is site data rather than reviewable logic: the
# fleet's MAC addresses, LAN IPs, and booted operating-system kinds. Everything else — the lore, the router endpoints, the ssh
# aliases, the logic — is tracked in ludics, so an in-place edit shows up in `git status`
# (ludics-lite#31). The MACs below are 00:00:00 placeholders on purpose; a real one in this file
# is a leak, and scripts/test-wake-lab.sh fails the repository if one appears. The IPs are
# likewise fictitious, from RFC 5737's documentation range (192.0.2.0/24) rather than from any
# real LAN: a template carrying the author's leases would be site data by another name.
#
# The box names must be the ones the script knows: rog, minix, tuf, macbook -- each needs a row in the
# endpoint map (ENDPOINT_MAP in wake-lab.sh), which holds the box's ssh aliases, so this file
# never names one. Each function echoes the value(s) for a known box and returns 1 for anything
# else; all four are required.
# Sourced by a `set -u` script under bash 3.2: no associative arrays.

# Every MAC of a box, Wi-Fi and Ethernet. wake() sends a magic packet to each — the Wi-Fi ones
# never wake a PC (see the lore in wake-lab.sh) but cost nothing and keep this table readable
# against the router's own host list; a sleeping Mac's Wi-Fi is the exception. A box none of whose NICs wakes on LAN can never be woken,
# cabled or not: list its MACs here, and leave it out of eth_mac_of.
mac_of() { case "$1" in
  rog)   echo 00:00:00:00:00:01 00:00:00:00:00:02 ;;  # Wi-Fi, Ethernet
  minix) echo 00:00:00:00:00:03 00:00:00:00:00:04 ;;  # Wi-Fi, Ethernet
  tuf)   echo 00:00:00:00:00:05 00:00:00:00:00:06 ;;  # Wi-Fi, Ethernet (no WoL): manual wake
  macbook) echo 00:00:00:00:00:07 ;;                  # Wi-Fi (its hardware MAC, Private Wi-Fi Address off)
  *) return 1 ;; esac; }

# The MAC of the NIC that wakes the box — the Ethernet one on a PC, the Wi-Fi one on a Mac, which
# wakes from sleep on AC (ludics#538). router_active() asks the router about this MAC, and `status`
# prints the router's NewActive bit for it as router-active. A box none of whose NICs wakes it
# belongs in neither branch: returning 1 is what makes its router-active read `?` and makes wake
# and the reboots refuse it.
eth_mac_of() { case "$1" in
  rog)   echo 00:00:00:00:00:02 ;;
  minix) echo 00:00:00:00:00:04 ;;
  macbook) echo 00:00:00:00:00:07 ;;  # Wi-Fi: from sleep only, never from a shutdown
  *) return 1 ;; esac; }

# The LAN IP of each box's cabled NIC. Nothing in wake-lab.sh calls this today — the -lan ssh
# aliases resolve these through ~/.ssh/config — but it is the record of which lease is the live
# one, which is exactly the question a stale Wi-Fi lease makes hard to answer.
ip_of() { case "$1" in
  rog)   echo 192.0.2.30 ;;  # Ethernet; its Wi-Fi lease is a different address
  minix) echo 192.0.2.31 ;;  # Ethernet
  tuf)   echo 192.0.2.35 ;;  # Ethernet, no WoL; its Wi-Fi lease is a different address
  macbook) echo 192.0.2.36 ;;  # Wi-Fi
  *) return 1 ;; esac; }

# The OS reached after a magic packet depends on the box's boot selection. Set this to the
# currently booted OS before operating a dual-boot box; status also probes and reports what
# actually answered. A native Ubuntu box needs no Windows-side WSL kick or holder.
kind_of() { case "$1" in
  rog|minix) echo linux ;;  # set to wsl if the box boots Windows/WSL instead
  tuf)       echo linux ;;
  macbook)   echo macos ;;  # a Mac boots nothing else
  *) return 1 ;; esac; }
