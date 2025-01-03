# logseq-wallabag

**Heavily under development, not ready for production use yet!**

This plugin is heavily based on https://github.com/omnivore-app/logseq-omnivore (thank you!). This is an attempt to migrate it to use wallabag. Me - the author - decided to give it a shot after Omnivore closed the shop and I migrated to Wallabag. 

I am very open to accepting more authors and contributors!

## How to use
Currently you won't be able to install the plugin in other way then manually building it and loading it as in Development section. Once you have it installed though, you should be able to put in your Wallabag API credentials (similarly to the Chrome plugin, that is Client ID, Client secret, URL, username, password) and run `Cmd+K` and then `Sync wallabag`. It should sync your Wallabag articles.


### TODO:
- [ ] remove all necessary bloat from the old plugin (the original plugin had much more knobs and switches which we currently do not support). Note that it might be easier to just start from scratch and manually copying the functionality than going from the previous repo first.
- [ ] rename all functions appropriately, ideally in a way where fetching data would be located in the API and the rest of the codebase could be generic
- [ ] make a proper logseq plugin release to use for everyone
- [ ] add more cool features!

## Development
1. install `pnpm`
2. install dependencies `pnpm install`
3. run `pnpm run dev`, build should happen and a new `dist` repository should show up
4. go to logseq, enable developer mode, go to plugins, click `load unpacked` and locate the root repository (not just the nested `dist` folder)
5. set up the plugin using the settings

It should pick up the build and as you load it, and it should (re)fetch your articles. If running in a dev mode, all you need to do after a new build is to click the `Reload` button at the logseq Plugins page. 