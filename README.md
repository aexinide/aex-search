# Aex Search

**Fast popup search for applications, files, folders, and file contents
on GNOME.**

Aex Search is a GNOME Shell extension designed to make common searches
accessible from the keyboard. It opens a popup with live results,
highlighted matches, and full paths.

## Features

-   Search across files and folders.
-   Search applications separately.
-   Search inside files.
-   View live results as you type.
-   See highlighted matches and full file paths.
-   Use keyboard shortcuts to open the relevant search mode.

## Keyboard shortcuts

  Shortcut                 Action
  ------------------------ --------------------------
  `Ctrl` + `Shift` + `S`   Search everything
  `Ctrl` + `Shift` + `F`   Search files and folders
  `Ctrl` + `Shift` + `A`   Search applications
  `Ctrl` + `Shift` + `G`   Search inside files

## Requirements

-   GNOME Shell. The extension metadata currently declares GNOME Shell
    versions 45--50; compatibility can vary by release and should be
    tested on your system.
-   `fd-find` and `ripgrep` are recommended search utilities.

On Ubuntu, you can install the recommended utilities with:

``` bash
sudo apt update
sudo apt install fd-find ripgrep
```

On Ubuntu, the `fd` executable may be named `fdfind`. If search does not
work after installing the package, check the executable names expected
by the current extension code.

## Installation

### Install from a local clone

1.  Clone the repository:

    ``` bash
    git clone https://github.com/aexinide/aex-search.git
    cd aex-search
    ```

2.  Install the extension into your local GNOME extensions directory:

    ``` bash
    mkdir -p ~/.local/share/gnome-shell/extensions/aex-search@aexinide
    cp -a . ~/.local/share/gnome-shell/extensions/aex-search@aexinide/
    ```

3.  Compile the GSettings schema:

    ``` bash
    glib-compile-schemas ~/.local/share/gnome-shell/extensions/aex-search@aexinide/schemas
    ```

4.  Enable the extension:

    ``` bash
    gnome-extensions enable aex-search@aexinide
    ```

5.  If the extension does not appear or enable correctly, log out and
    log back in, then inspect its status and logs:

    ``` bash
    gnome-extensions info aex-search@aexinide
    journalctl -f -o cat /usr/bin/gnome-shell
    ```

    Stop the log command with `Ctrl+C`. On Wayland, logging out and back
    in is the usual way to restart GNOME Shell.

> These are manual installation steps for the current repository state.
> Installation behavior and dependencies may change as the project
> develops.

## Development

The extension source and settings are organized into these files:

-   `extension.js` --- extension entry point and runtime behavior.
-   `lib.js` --- supporting search utilities.
-   `prefs.js` --- preferences UI.
-   `metadata.json` --- extension metadata and declared GNOME Shell
    versions.
-   `schemas/` --- GSettings schema.
-   `stylesheet.css` --- popup styling.

To test changes, copy the updated files into the installed extension
directory, recompile the schema if the schema XML changes, and reload
the extension or log out and back in. Check GNOME Shell logs if an error
occurs.

## Roadmap

Potential areas for improvement include:

-   Broader testing across supported GNOME Shell releases.
-   Clearer dependency detection and setup guidance.
-   Additional search filters and quality-of-life improvements.
-   User reports and contributor feedback.

This roadmap is a starting point; proposed features and priorities can
be discussed through GitHub Issues.

## Contributing

Contributions, bug reports, and suggestions are welcome.

1.  Open an issue describing the problem or proposed change.
2.  For code changes, create a focused branch.
3.  Test the extension on your GNOME Shell version.
4.  Submit a pull request with a clear summary and testing notes.

Please avoid unrelated refactors in bug-fix pull requests so changes are
easy to review.

## Issues and feedback

-   Repository: https://github.com/aexinide/aex-search
-   Report bugs or request features through the repository's **Issues**
    tab.

## License

See the [`LICENSE`](LICENSE) file in this repository.
