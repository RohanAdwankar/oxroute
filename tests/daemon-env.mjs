// Disposable daemons get only what they need to run, never the live daemon's owner, tokens or database.
export const baseEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',...(process.env.LD_LIBRARY_PATH&&{LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH})};
