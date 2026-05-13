import chalk from 'chalk';

const pad = (n) => String(n).padStart(2, '0');

function timestamp() {
  const now = new Date();
  return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

export const logger = {
  info: (msg, ...args) => console.log(chalk.cyan(`${timestamp()} [INFO]`), msg, ...args),
  success: (msg, ...args) => console.log(chalk.green(`${timestamp()} [OK]`), msg, ...args),
  warn: (msg, ...args) => console.log(chalk.yellow(`${timestamp()} [WARN]`), msg, ...args),
  error: (msg, ...args) => console.log(chalk.red(`${timestamp()} [ERROR]`), msg, ...args),
  trade: (msg, ...args) => console.log(chalk.magenta(`${timestamp()} [TRADE]`), msg, ...args),
  scan: (msg, ...args) => console.log(chalk.blue(`${timestamp()} [SCAN]`), msg, ...args),
  security: (msg, ...args) => console.log(chalk.yellow(`${timestamp()} [SEC]`), msg, ...args),
  monitor: (msg, ...args) => console.log(chalk.gray(`${timestamp()} [MON]`), msg, ...args),
};
